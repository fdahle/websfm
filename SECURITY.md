# Security policy

websfm runs entirely in your browser. There is no websfm server and no account, and
your images and projects never leave your machine. Security issues are still
possible, most likely in how the app reads files you open: project archives
(`.websfm`), images and TIFFs, point clouds (PLY, LAS/LAZ), COLMAP models, CSV
imports and GeoTIFFs.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub instead:
go to the repository's **Security** tab and choose **Report a vulnerability**.

Useful details:
- what an attacker could achieve (for example script execution, reading other
  projects, or a crash or hang from a crafted file);
- the steps or a minimal file that reproduces it;
- browser, version and operating system.

You should get a first reply within a week. Please give a reasonable amount of time
for a fix before disclosing the issue publicly.

## Supported versions

websfm is in beta. Fixes go into the latest version on `main` only.
