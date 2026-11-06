// Ceres on a BAL problem (Bundle Adjustment in the Large), the reference the crate's
// bundle adjustment is compared with (scripts/bench/bal/run.mjs, crates/reconstruction/
// examples/bal.rs). The residual is Ceres' own for BAL (examples/snavely_reprojection_
// error.h): angle-axis rotation, p = −x_c / z_c, f·(1 + k1·|p|² + k2·|p|⁴)·p. No robust
// loss, Levenberg–Marquardt, the Schur complement solved exactly (SPARSE_SCHUR), Ceres'
// default tolerances. Prints one JSON line.
//
//   ceres_bal <problem.txt> [max_iters] [threads] [sparse_schur|iterative_schur]
//
// BAL_F32_START=1 rounds the start (cameras, points, observations) to float first, as the
// crate's f32 interface does, to tell a different start from a different solver.
// BAL_TRACE=1 prints Ceres' per-iteration progress before the JSON line.
//
// Built by run.mjs against a Ceres install (CERES_PREFIX, e.g. a conda env with
// ceres-solver, glog, gflags and eigen).

#include <ceres/ceres.h>
#include <ceres/rotation.h>

#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

struct SnavelyReprojectionError {
  SnavelyReprojectionError(double x, double y) : x(x), y(y) {}
  template <typename T>
  bool operator()(const T* camera, const T* point, T* residuals) const {
    T p[3];
    ceres::AngleAxisRotatePoint(camera, point, p);
    p[0] += camera[3];
    p[1] += camera[4];
    p[2] += camera[5];
    const T xp = -p[0] / p[2];
    const T yp = -p[1] / p[2];
    const T r2 = xp * xp + yp * yp;
    const T distortion = 1.0 + r2 * (camera[7] + camera[8] * r2);
    residuals[0] = camera[6] * distortion * xp - x;
    residuals[1] = camera[6] * distortion * yp - y;
    return true;
  }
  double x, y;
};

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: ceres_bal <problem.txt> [max_iters] [threads] [sparse_schur|iterative_schur]\n");
    return 2;
  }
  const char* path = argv[1];
  const int max_iters = argc > 2 ? std::atoi(argv[2]) : 100;
  const int threads = argc > 3 ? std::atoi(argv[3]) : 1;
  const std::string linear = argc > 4 ? argv[4] : "sparse_schur";
  FILE* f = std::fopen(path, "r");
  if (!f) {
    std::perror(path);
    return 1;
  }
  int n_cam, n_pts, n_obs;
  if (std::fscanf(f, "%d %d %d", &n_cam, &n_pts, &n_obs) != 3) return 1;
  std::vector<int> oc(n_obs), op(n_obs);
  std::vector<double> ox(n_obs), oy(n_obs), cams(9 * n_cam), pts(3 * n_pts);
  for (int i = 0; i < n_obs; ++i)
    if (std::fscanf(f, "%d %d %lf %lf", &oc[i], &op[i], &ox[i], &oy[i]) != 4) return 1;
  for (double& v : cams)
    if (std::fscanf(f, "%lf", &v) != 1) return 1;
  for (double& v : pts)
    if (std::fscanf(f, "%lf", &v) != 1) return 1;
  std::fclose(f);
  if (std::getenv("BAL_F32_START")) {
    for (double& v : cams) v = static_cast<float>(v);
    for (double& v : pts) v = static_cast<float>(v);
    for (double& v : ox) v = static_cast<float>(v);
    for (double& v : oy) v = static_cast<float>(v);
  }

  ceres::Problem problem;
  for (int i = 0; i < n_obs; ++i) {
    auto* cost = new ceres::AutoDiffCostFunction<SnavelyReprojectionError, 2, 9, 3>(
        new SnavelyReprojectionError(ox[i], oy[i]));
    problem.AddResidualBlock(cost, nullptr, &cams[9 * oc[i]], &pts[3 * op[i]]);
  }
  ceres::Solver::Options options;
  options.minimizer_type = ceres::TRUST_REGION;
  options.trust_region_strategy_type = ceres::LEVENBERG_MARQUARDT;
  if (linear == "iterative_schur") {
    options.linear_solver_type = ceres::ITERATIVE_SCHUR;
    options.preconditioner_type = ceres::SCHUR_JACOBI;
  } else {
    options.linear_solver_type = ceres::SPARSE_SCHUR;
  }
  options.max_num_iterations = max_iters;
  options.num_threads = threads;
  options.logging_type = ceres::SILENT;
  if (std::getenv("BAL_TRACE")) {
    options.logging_type = ceres::PER_MINIMIZER_ITERATION;
    options.minimizer_progress_to_stdout = true;
  }
  ceres::Solver::Summary s;
  ceres::Solve(options, &problem, &s);
  std::printf(
      "{\"file\":\"%s\",\"solver\":\"ceres-%s\",\"cameras\":%d,\"points\":%d,\"observations\":%d,"
      "\"initial_cost\":%.10e,\"final_cost\":%.10e,\"iterations\":%d,\"successful_steps\":%d,"
      "\"linear_solves\":%d,\"solve_s\":%.3f,\"termination\":\"%s\",\"threads\":%d}\n",
      path, linear.c_str(), n_cam, n_pts, n_obs, s.initial_cost, s.final_cost,
      s.num_successful_steps + s.num_unsuccessful_steps, s.num_successful_steps, s.num_linear_solves,
      s.total_time_in_seconds, ceres::TerminationTypeToString(s.termination_type), threads);
  return 0;
}
