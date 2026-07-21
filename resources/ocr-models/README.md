# OCR model boundary

The current V1 runtime uses the Windows system `Windows.Media.Ocr` API and the
OCR language packs already installed by the user. The application does not
ship, download, or update OCR model binaries, so the Phase 5 packaging pipeline
must leave this directory model-free.

`IOcrEngine` remains replaceable. Introducing PaddleOCR or another packaged
runtime/model requires a new ADR, pinned runtime and model hashes, a license and
SBOM review, quality and minimum-CPU matrices, and a new package-size budget.
Those future files must remain outside the Electron ASAR archive.
