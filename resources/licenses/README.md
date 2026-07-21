# Third-party notices

The release pipeline must place notices for the exact components redistributed
by the signed artifact in this directory, including Electron, production NPM
dependencies, the installer toolchain/runtime, and any redistributed Native
runtime files. Build-only and operating-system dependencies must be listed
separately.

The current V1 does not redistribute PaddleOCR, OpenCV, or OCR model files;
their notices must not be fabricated as shipped components. If those assets are
introduced later, their pinned versions, hashes, sources, licenses, and notices
become release gates.
