"""Export ALIKED (aliked-n16) and its LightGlue to ONNX for websfm's learned front end.

fabio-sim/LightGlue-ONNX ships ALIKED only as a fused two-image pipeline, which does
not fit websfm's per-image keypoint stage. This script exports the two halves
separately, in the same tensor layout as the shipped SuperPoint/DISK files, so the
existing runners drive them unchanged:

  aliked.onnx           image [1,3,H,W] RGB in [0,1], any H and W
                        -> keypoints [1,N,2] float (x, y in input pixels, pixel
                           centres at integers), scores [1,N], descriptors [1,N,128]
                           (core/features/learnedDetect.js)
  lightglue_aliked.onnx kpts0 [1,N0,2], kpts1 [1,N1,2] float, normalised as
                        (kpt - [w/2, h/2]) / (max(w, h) / 2); desc0 [1,N0,128], desc1
                        -> matches0 [M,2] int64, mscores0 [M] float
                           (core/features/lightglue.js)

The networks are cvg/LightGlue's own modules with their published weights; only the
parts that do not export are rewritten, each to the same arithmetic:

  - torchvision's deform_conv2d (backbone blocks 3 and 4) has no ONNX Runtime Web
    kernel. It becomes one GridSample over the 9 kernel taps plus a 1x1 Conv, which
    samples exactly as torchvision does (bilinear, zero outside the map).
  - Detection (DKD) runs in threshold mode (score > 0.2, NMS radius 2, as upstream's
    default), with the data-dependent branches made graph ops: the mean-score
    fallback is a Where, and the cap keeps the N_LIMIT best by score (upstream keeps
    20,000 in raster order; the app caps far lower and re-sorts by score anyway).
    The 5x5 soft-argmax gathers only around each keypoint instead of unfolding the
    whole score map.
  - LightGlue runs all 9 layers (no early stop or point pruning, like the fabio-sim
    exports) and filters mutual matches above 0.1, as upstream does.

Usage (a fresh env with CPU torch, torchvision, kornia, onnx, onnxruntime, pillow):

  git clone https://github.com/cvg/LightGlue <checkout>
  python -I scripts/models/export-aliked.py --lightglue <checkout> --out public/models \\
      --verify <image> [<image> ...]

Weights download through torch.hub (set TORCH_HOME to choose where): ALIKED from
github.com/Shiaoming/ALIKED (BSD-3-Clause), LightGlue from cvg/LightGlue's v0.1_arxiv
release (Apache-2.0). `--verify` compares each ONNX graph, run on ONNX Runtime CPU,
with the upstream PyTorch model on the given images.
"""

import argparse
import hashlib
import sys
import types
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
import torch.onnx.operators
from torch import nn

N_LIMIT = 8192  # most keypoints the extractor emits (the Detect dialog's learned max)
DETECTION_THRESHOLD = 0.2
NMS_RADIUS = 2
FILTER_THRESHOLD = 0.1
OPSET = 17  # the opset of the shipped fabio-sim exports


def shape_of(x):
    """Shape as a traced int64 tensor, so H and W stay symbolic in the graph."""
    return torch.onnx.operators.shape_as_tensor(x)


# --- Deformable convolution without torchvision ----------------------------------


def deform_conv2d_grid(x, offset, weight, padding, k=3):
    """torchvision.ops.deform_conv2d for ALIKED's case: 3x3, stride 1, dilation 1,
    one offset group, no mask, no bias. The 9 taps are sampled in ONE GridSample
    (align_corners=True maps pixel centres onto -1..1; zeros padding is
    torchvision's zero-outside bilinear), then contracted with a 1x1 Conv whose
    input channels are ordered (channel, tap): `weight` is the 3x3 kernel already
    reshaped to [O, C*9, 1, 1] (a fixed-shape parameter, which the Conv export needs)."""
    taps = k * k
    s = shape_of(x)
    h, w = s[2], s[3]
    c = x.shape[1]
    hf, wf = h.to(x.dtype), w.to(x.dtype)
    ys = torch.arange(h).to(x.dtype).reshape(1, 1, -1, 1)
    xs = torch.arange(w).to(x.dtype).reshape(1, 1, 1, -1)
    ki = torch.arange(taps, dtype=torch.int64) // k
    kj = torch.arange(taps, dtype=torch.int64) % k
    ki = (ki - padding).to(x.dtype).reshape(1, taps, 1, 1)
    kj = (kj - padding).to(x.dtype).reshape(1, taps, 1, 1)
    # offset channel 2t is the row (y) shift of tap t, 2t+1 the column (x) shift.
    off = offset.reshape(1, taps, 2, h, w)
    py = ys + ki + off[:, :, 0]
    px = xs + kj + off[:, :, 1]
    gx = 2 * px / (wf - 1) - 1
    gy = 2 * py / (hf - 1) - 1
    grid = torch.stack([gx, gy], -1).reshape(1, taps * h, w, 2)
    sampled = F.grid_sample(x, grid, mode='bilinear', padding_mode='zeros', align_corners=True)
    sampled = sampled.reshape(1, c * taps, h, w)  # [1, C, taps*H, W] -> channel-major
    return F.conv2d(sampled, weight)


def dcn_forward(self, x):
    s = shape_of(x)
    max_offset = torch.maximum(s[2], s[3]).to(x.dtype) / 4.0
    offset = self.offset_conv(x)
    offset = torch.minimum(torch.maximum(offset, -max_offset), max_offset)
    pad = self.padding[0] if isinstance(self.padding, (tuple, list)) else self.padding
    return deform_conv2d_grid(x, offset, self.weight_1x1, pad)


# --- ALIKED extractor ------------------------------------------------------------


class AlikedOnnx(nn.Module):
    """Upstream ALIKED.forward for one image (backbone, DKD, SDDH), traceable with
    symbolic H and W; outputs keypoints in input pixels, scores and descriptors."""

    def __init__(self, aliked, simple_nms, n_limit=N_LIMIT):
        super().__init__()
        self.m = aliked
        self.simple_nms = simple_nms
        self.n_limit = n_limit
        r = NMS_RADIUS
        ks = 2 * r + 1
        # Soft-argmax window, in torch Unfold order (row-major over (dy, dx)).
        dy = torch.arange(ks * ks) // ks - r
        dx = torch.arange(ks * ks) % ks - r
        self.register_buffer('win_dy', dy, persistent=False)
        self.register_buffer('win_dx', dx, persistent=False)
        self.register_buffer('hw_grid', torch.stack([dx, dy], 1).float(), persistent=False)

    def pad32(self, image):
        """InputPadder(divis_by=32): replicate padding split evenly over both sides."""
        s = shape_of(image)
        h, w = s[2], s[3]
        ph = (32 - h % 32) % 32
        pw = (32 - w % 32) % 32
        top, left = ph // 2, pw // 2
        rows = torch.clamp(torch.arange(h + ph) - top, min=0)
        rows = torch.minimum(rows, h - 1)
        cols = torch.clamp(torch.arange(w + pw) - left, min=0)
        cols = torch.minimum(cols, w - 1)
        return image.index_select(2, rows).index_select(3, cols), top, left, h, w

    def dense(self, image):
        m = self.m
        x, top, left, h, w = self.pad32(image)
        x1 = m.block1(x)
        x2 = m.block2(m.pool2(x1))
        x3 = m.block3(m.pool4(x2))
        x4 = m.block4(m.pool4(x3))
        x1 = m.gate(m.conv1(x1))
        x2 = m.gate(m.conv2(x2))
        x3 = m.gate(m.conv3(x3))
        x4 = m.gate(m.conv4(x4))
        x1234 = torch.cat([x1, m.upsample2(x2), m.upsample8(x3), m.upsample32(x4)], dim=1)
        score_map = torch.sigmoid(m.score_head(x1234))
        feature_map = F.normalize(x1234, p=2, dim=1)
        # Unpad. index_select, not slicing: a slice bound would be traced as a constant.
        rows, cols = torch.arange(h) + top, torch.arange(w) + left
        feature_map = feature_map.index_select(2, rows).index_select(3, cols)
        score_map = score_map.index_select(2, rows).index_select(3, cols)
        return feature_map, score_map, h, w

    def detect(self, score_map, h, w):
        r = NMS_RADIUS
        nms = self.simple_nms(score_map, r)
        # Zero an r-pixel border.
        ys = torch.arange(h)
        xs = torch.arange(w)
        keep_y = (ys >= r) & (ys < h - r)
        keep_x = (xs >= r) & (xs < w - r)
        border = (keep_y.reshape(-1, 1) & keep_x.reshape(1, -1)).to(nms.dtype)
        flat = (nms[0, 0] * border).reshape(-1)
        scores_flat = score_map.reshape(-1)
        # Threshold, or the mean score when nothing clears it (upstream's fallback).
        above = flat > DETECTION_THRESHOLD
        th = torch.where(above.any(), torch.tensor(DETECTION_THRESHOLD), scores_flat.mean())
        idx = torch.nonzero(flat > th)[:, 0]
        # Best n_limit by score. Slice past the end is clamped, so no branch on N.
        order = torch.argsort(scores_flat[idx], descending=True)[: self.n_limit]
        idx = idx[order]

        # Soft-argmax in the (2r+1)^2 window, gathered around each keypoint from a
        # zero-padded score map (what Unfold(padding=r) reads).
        ky = idx // w
        kx = idx % w
        padded = F.pad(score_map, (r, r, r, r)).reshape(-1)
        wp = w + 2 * r
        gidx = (ky.reshape(-1, 1) + r + self.win_dy.reshape(1, -1)) * wp \
            + (kx.reshape(-1, 1) + r + self.win_dx.reshape(1, -1))
        patch = padded[gidx]  # [N, 25]
        max_v = patch.max(dim=1).values.reshape(-1, 1)
        x_exp = ((patch - max_v) / 0.1).exp()
        xy_residual = x_exp @ self.hw_grid / x_exp.sum(dim=1).reshape(-1, 1)
        kxy = torch.stack([kx, ky], 1).to(score_map.dtype) + xy_residual
        wh = torch.stack([w - 1, h - 1]).to(score_map.dtype).reshape(1, 2)
        kxy_n = kxy / wh * 2 - 1
        kscore = F.grid_sample(score_map, kxy_n.reshape(1, 1, -1, 2), mode='bilinear',
                               align_corners=True).reshape(-1)
        return kxy_n, kscore, wh

    def describe(self, feature_map, kxy_n, wh):
        """SDDH (ALIKED's sparse deformable descriptor head) for one image."""
        head = self.m.desc_head
        c = feature_map.shape[1]
        s = shape_of(feature_map)
        h, w = s[2], s[3]
        max_offset = torch.maximum(h, w).to(feature_map.dtype) / 4.0
        kwh = (kxy_n / 2 + 0.5) * wh  # pixel coordinates, as upstream round-trips them
        ps = head.kernel_size
        # get_patches: a ps x ps window whose corner is (kpt - ps/2 + 1) truncated,
        # clamped so the window stays inside [0, w-1-ps] x [0, h-1-ps].
        corner = (kwh.to(torch.int64).to(kwh.dtype) - ps / 2 + 1).to(torch.int64)
        cx = torch.minimum(torch.clamp(corner[:, 0], min=0), w - 1 - ps)
        cy = torch.minimum(torch.clamp(corner[:, 1], min=0), h - 1 - ps)
        a = torch.arange(ps * ps) // ps
        b = torch.arange(ps * ps) % ps
        pidx = (cy.reshape(-1, 1) + a.reshape(1, -1)) * w + (cx.reshape(-1, 1) + b.reshape(1, -1))
        fm = feature_map.reshape(c, -1)
        patch = fm[:, pidx]  # [C, N, ps*ps]
        patch = patch.permute(1, 0, 2).reshape(-1, c, ps, ps)
        offset = head.offset_conv(patch)
        offset = torch.minimum(torch.maximum(offset, -max_offset), max_offset)
        n_pos = head.n_pos
        offset = offset.reshape(-1, 2, n_pos).permute(0, 2, 1)  # [N, n_pos, 2] (x, y)
        pos = kwh.reshape(-1, 1, 2) + offset
        pos = 2.0 * pos / wh.reshape(1, 1, 2) - 1
        feats = F.grid_sample(feature_map, pos.reshape(1, -1, 1, 2), mode='bilinear',
                              align_corners=True)  # [1, C, N*n_pos, 1]
        feats = feats.reshape(c, -1, n_pos).permute(1, 0, 2)  # [N, C, n_pos]
        sf = head.sf_conv.weight.reshape(c, c)  # 1x1 conv, no bias
        feats = F.selu(torch.matmul(sf, feats))  # [N, C, n_pos]
        # einsum('ncp,pcd->nd') as one MatMul over (p, c).
        agg = head.agg_weights.reshape(n_pos * c, -1)
        descs = feats.permute(0, 2, 1).reshape(-1, n_pos * c) @ agg
        return F.normalize(descs, p=2.0, dim=1)

    def forward(self, image):
        feature_map, score_map, h, w = self.dense(image)
        kxy_n, kscore, wh = self.detect(score_map, h, w)
        descs = self.describe(feature_map, kxy_n, wh)
        keypoints = wh * (kxy_n + 1) / 2.0
        return keypoints.unsqueeze(0), kscore.unsqueeze(0), descs.unsqueeze(0)


# --- LightGlue -------------------------------------------------------------------


class MultiHeadAttention(torch.autograd.Function):
    """softmax(q k^T / sqrt(head_dim)) v on [1, N, heads*head_dim] tensors, exported as
    ONNX Runtime's com.microsoft MultiHeadAttention: one fused kernel per attention
    on both the WASM and WebGPU EPs (the shipped fabio-sim LightGlue files use it too;
    unfused MatMul/Softmax ran ~30% slower on WASM)."""

    @staticmethod
    def forward(ctx, q, k, v, heads):
        hd = q.shape[-1] // heads
        split = lambda t: t.reshape(1, -1, heads, hd).transpose(1, 2)  # noqa: E731
        attn = torch.softmax((split(q) @ split(k).transpose(-2, -1)) * hd ** -0.5, -1)
        return (attn @ split(v)).transpose(1, 2).reshape(1, -1, heads * hd)

    @staticmethod
    def symbolic(g, q, k, v, heads):
        out = g.op('com.microsoft::MultiHeadAttention', q, k, v, num_heads_i=heads)
        out.setType(q.type())
        return out


class LightGlueOnnx(nn.Module):
    """Full-depth LightGlue on pre-normalised keypoints, mutual matches above the
    filter threshold as [M,2] index pairs + scores (the fabio-sim output layout).
    The blocks are upstream's, re-stated with explicit-rank reshapes (the exporter
    cannot follow `unflatten(-1, (h, -1, 3))`) and fused attention."""

    def __init__(self, lg):
        super().__init__()
        self.lg = lg
        self.heads = lg.conf.num_heads
        self.head_dim = lg.conf.descriptor_dim // self.heads

    def posenc(self, kpts):
        """LearnableFourierPositionalEncoding -> [2 (cos, sin), 1, 1, N, head_dim]."""
        projected = self.lg.posenc.Wr(kpts)  # [1, N, hd/2]
        emb = torch.stack([torch.cos(projected), torch.sin(projected)], 0).unsqueeze(-3)
        return torch.stack([emb, emb], -1).reshape(2, 1, 1, -1, self.head_dim)  # repeat_interleave(2)

    def rotary(self, enc, t):
        half = t.reshape(1, self.heads, -1, self.head_dim // 2, 2)
        rot = torch.stack([-half[..., 1], half[..., 0]], -1).reshape(1, self.heads, -1, self.head_dim)
        return t * enc[0] + rot * enc[1]

    def merge_heads(self, t):
        return t.transpose(1, 2).reshape(1, -1, self.heads * self.head_dim)

    def attend(self, q, k, v):
        return MultiHeadAttention.apply(q, k, v, self.heads)

    def self_block(self, blk, x, enc):
        qkv = blk.Wqkv(x).reshape(1, -1, self.heads, self.head_dim, 3).transpose(1, 2)
        q, k, v = qkv[..., 0], qkv[..., 1], qkv[..., 2]
        # Rotary encoding acts per head, so it is applied before the heads are merged.
        q, k = self.rotary(enc, q), self.rotary(enc, k)
        context = self.attend(self.merge_heads(q), self.merge_heads(k), self.merge_heads(v))
        return x + blk.ffn(torch.cat([x, blk.out_proj(context)], -1))

    def cross_block(self, blk, x0, x1):
        # Upstream scales both sides by scale**0.5: the product is MHA's 1/sqrt(head_dim).
        qk0, qk1 = blk.to_qk(x0), blk.to_qk(x1)
        v0, v1 = blk.to_v(x0), blk.to_v(x1)
        m0 = blk.to_out(self.attend(qk0, qk1, v1))
        m1 = blk.to_out(self.attend(qk1, qk0, v0))
        return x0 + blk.ffn(torch.cat([x0, m0], -1)), x1 + blk.ffn(torch.cat([x1, m1], -1))

    def forward(self, kpts0, kpts1, desc0, desc1):
        lg = self.lg
        d0, d1 = lg.input_proj(desc0), lg.input_proj(desc1)
        e0, e1 = self.posenc(kpts0), self.posenc(kpts1)
        for layer in lg.transformers:
            d0 = self.self_block(layer.self_attn, d0, e0)
            d1 = self.self_block(layer.self_attn, d1, e1)
            d0, d1 = self.cross_block(layer.cross_attn, d0, d1)
        la = lg.log_assignment[-1]
        md0, md1 = la.final_proj(d0), la.final_proj(d1)
        scale = md0.shape[-1] ** 0.25
        sim = (md0 / scale) @ (md1 / scale).transpose(1, 2)
        z0, z1 = la.matchability(d0), la.matchability(d1)
        # The [M,N] block of sigmoid_log_double_softmax; filter_matches never reads
        # the dustbin row and column.
        scores = F.log_softmax(sim, 2) + F.log_softmax(sim, 1) \
            + F.logsigmoid(z0) + F.logsigmoid(z1).transpose(1, 2)
        max0, max1 = scores.max(2), scores.max(1)
        m0, m1 = max0.indices, max1.indices
        i0 = torch.arange(m0.shape[1]).reshape(1, -1)
        mutual0 = i0 == m1.gather(1, m0)
        mscores0 = torch.where(mutual0, max0.values.exp(), torch.zeros_like(max0.values))
        valid0 = mutual0 & (mscores0 > FILTER_THRESHOLD)
        idx0 = torch.nonzero(valid0[0])[:, 0]
        matches0 = torch.stack([idx0, m0[0][idx0]], -1)
        return matches0, mscores0[0][idx0]


# --- loading, export, verification -----------------------------------------------


def load_upstream(repo):
    sys.path.insert(0, str(Path(repo).resolve()))
    from lightglue import aliked as aliked_mod  # noqa: E402
    from lightglue.lightglue import LightGlue  # noqa: E402

    extractor = aliked_mod.ALIKED(model_name='aliked-n16', max_num_keypoints=-1,
                                  detection_threshold=DETECTION_THRESHOLD,
                                  nms_radius=NMS_RADIUS).eval()
    matcher = LightGlue(features='aliked', depth_confidence=-1, width_confidence=-1,
                        filter_threshold=FILTER_THRESHOLD, flash=False).eval()
    return aliked_mod, extractor, matcher


def finalize(path, fixed_dims):
    """Pin static output axes, then check the graph."""
    import onnx
    model = onnx.load(str(path))
    for out in model.graph.output:
        for axis, value in fixed_dims.get(out.name, {}).items():
            out.type.tensor_type.shape.dim[axis].dim_value = value
    onnx.checker.check_model(model)
    onnx.save(model, str(path))


def export_extractor(aliked_mod, extractor, path):
    import copy
    m = copy.deepcopy(extractor)
    for mod in m.modules():
        if isinstance(mod, aliked_mod.DeformableConv2d):
            w = mod.regular_conv.weight.detach()
            mod.weight_1x1 = nn.Parameter(w.reshape(w.shape[0], -1, 1, 1).clone(), requires_grad=False)
            mod.forward = types.MethodType(dcn_forward, mod)
    wrapper = AlikedOnnx(m, aliked_mod.simple_nms).eval()
    dummy = torch.rand(1, 3, 480, 640)
    torch.onnx.export(
        wrapper, (dummy,), str(path), dynamo=False, opset_version=OPSET,
        input_names=['image'], output_names=['keypoints', 'scores', 'descriptors'],
        dynamic_axes={'image': {2: 'height', 3: 'width'},
                      'keypoints': {1: 'num_keypoints'}, 'scores': {1: 'num_keypoints'},
                      'descriptors': {1: 'num_keypoints'}},
    )
    # The tracer leaves the (x, y) and descriptor axes symbolic; pin them.
    finalize(path, {'keypoints': {2: 2}, 'descriptors': {2: 128}})
    return wrapper


def export_matcher(matcher, path):
    wrapper = LightGlueOnnx(matcher).eval()
    n0, n1 = 512, 600
    args = (torch.rand(1, n0, 2) * 2 - 1, torch.rand(1, n1, 2) * 2 - 1,
            F.normalize(torch.randn(1, n0, 128), dim=-1), F.normalize(torch.randn(1, n1, 128), dim=-1))
    torch.onnx.export(
        wrapper, args, str(path), dynamo=False, opset_version=OPSET,
        custom_opsets={'com.microsoft': 1},
        input_names=['kpts0', 'kpts1', 'desc0', 'desc1'], output_names=['matches0', 'mscores0'],
        dynamic_axes={'kpts0': {1: 'num_keypoints0'}, 'kpts1': {1: 'num_keypoints1'},
                      'desc0': {1: 'num_keypoints0'}, 'desc1': {1: 'num_keypoints1'},
                      'matches0': {0: 'num_matches'}, 'mscores0': {0: 'num_matches'}},
    )
    finalize(path, {'matches0': {1: 2}})
    return wrapper


def load_image(path, max_dim):
    from PIL import Image
    im = Image.open(path).convert('RGB')
    s = max_dim / max(im.size)
    if s < 1:
        im = im.resize((round(im.width * s), round(im.height * s)), Image.BILINEAR)
    return torch.from_numpy(np.asarray(im, dtype=np.float32) / 255.0).permute(2, 0, 1)[None]


def normalize_kpts(k, w, h):
    return (k - torch.tensor([w / 2, h / 2])) / (max(w, h) / 2)


def verify(extractor, matcher, x_path, m_path, images, max_dim):
    import onnxruntime as ort
    so = ort.SessionOptions()
    xs = ort.InferenceSession(str(x_path), so, providers=['CPUExecutionProvider'])
    ms = ort.InferenceSession(str(m_path), so, providers=['CPUExecutionProvider'])
    feats = []
    print(f'extractor: upstream PyTorch vs {x_path.name} on ONNX Runtime {ort.__version__} CPU')
    for p in images:
        img = load_image(p, max_dim)
        with torch.no_grad():
            ref = extractor({'image': img})
        kr = ref['keypoints'][0].numpy()
        sr = ref['keypoint_scores'][0].numpy()
        dr = ref['descriptors'][0].numpy()
        ko, so_, do = xs.run(None, {'image': img.numpy()})
        ko, so_, do = ko[0], so_[0], do[0]
        # Same keypoint set? Upstream keeps raster order, ours is score-sorted: pair
        # them as mutual nearest neighbours, then compare coordinates, scores and
        # descriptors of the pairs.
        d2 = ((kr[:, None, :] - ko[None, :, :]) ** 2).sum(-1)
        nn_o, nn_r = d2.argmin(1), d2.argmin(0)
        ir = np.array([i for i in range(len(kr)) if nn_r[nn_o[i]] == i], dtype=np.int64)
        io = nn_o[ir]
        dk = np.abs(kr[ir] - ko[io]).max() if len(ir) else float('nan')
        ds = np.abs(sr[ir] - so_[io]).max() if len(ir) else float('nan')
        dd = np.abs(dr[ir] - do[io]).max() if len(ir) else float('nan')
        print(f'  {Path(p).name} {img.shape[3]}x{img.shape[2]}: upstream {len(kr)} kpts, onnx {len(ko)}, '
              f'paired {len(ir)}; max |dxy| {dk:.2e} px, |dscore| {ds:.2e}, |ddesc| {dd:.2e}')
        feats.append((img.shape[3], img.shape[2], kr, dr, ko, do))

    print(f'matcher: upstream LightGlue (full depth) vs {m_path.name}')
    for a in range(len(feats) - 1):
        wa, ha, kra, dra, koa, doa = feats[a]
        wb, hb, krb, drb, kob, dob = feats[a + 1]
        # Both on the ONNX extractor's features, so only the matcher differs.
        with torch.no_grad():
            ref = matcher({
                'image0': {'keypoints': torch.from_numpy(koa)[None], 'descriptors': torch.from_numpy(doa)[None],
                           'image_size': torch.tensor([[wa, ha]])},
                'image1': {'keypoints': torch.from_numpy(kob)[None], 'descriptors': torch.from_numpy(dob)[None],
                           'image_size': torch.tensor([[wb, hb]])},
            })
        m0 = ref['matches0'][0].numpy()
        s0 = ref['matching_scores0'][0].numpy()
        k0 = normalize_kpts(torch.from_numpy(koa), wa, ha).numpy()[None].astype(np.float32)
        k1 = normalize_kpts(torch.from_numpy(kob), wb, hb).numpy()[None].astype(np.float32)
        mo, so_ = ms.run(None, {'kpts0': k0, 'kpts1': k1, 'desc0': doa[None], 'desc1': dob[None]})
        ref_pairs = {(i, int(j)) for i, j in enumerate(m0) if j >= 0}
        onnx_pairs = {(int(i), int(j)) for i, j in mo}
        common = ref_pairs & onnx_pairs
        ref_s = {(i, int(j)): s0[i] for i, j in enumerate(m0) if j >= 0}
        dsc = max((abs(ref_s[(int(i), int(j))] - s) for (i, j), s in zip(mo, so_) if (int(i), int(j)) in ref_s),
                  default=float('nan'))
        print(f'  pair {a}-{a + 1}: upstream {len(ref_pairs)} matches, onnx {len(onnx_pairs)}, '
              f'common {len(common)}; max |dscore| {dsc:.2e}')


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--lightglue', required=True, help='a cvg/LightGlue checkout')
    ap.add_argument('--out', required=True, help='output directory (e.g. public/models)')
    ap.add_argument('--verify', nargs='*', default=[], help='images to compare ONNX against PyTorch on')
    # 1024 is a multiple of 32 (no padding); 1000 exercises the replicate padding.
    ap.add_argument('--verify-max-dim', type=int, nargs='+', default=[1024, 1000])
    a = ap.parse_args()

    torch.set_grad_enabled(False)
    aliked_mod, extractor, matcher = load_upstream(a.lightglue)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    x_path, m_path = out / 'aliked.onnx', out / 'lightglue_aliked.onnx'
    export_extractor(aliked_mod, extractor, x_path)
    export_matcher(matcher, m_path)
    for p in (x_path, m_path):
        print(f'{p}: {p.stat().st_size} bytes, sha256 {sha256(p)}')
    if a.verify:
        for max_dim in a.verify_max_dim:
            verify(extractor, matcher, x_path, m_path, a.verify, max_dim)


if __name__ == '__main__':
    main()
