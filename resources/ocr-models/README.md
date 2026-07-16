# OCR model boundary

Phase 1 does not commit model binaries. The Native Host consumes a versioned,
locally packaged OCR model set through `IOcrEngine`. A concrete PaddleOCR
runtime/model version is selected only after the Phase 1 Windows benchmark and
license inventory are recorded. Model files are placed here by the packaging
pipeline and remain outside the Electron ASAR archive.
