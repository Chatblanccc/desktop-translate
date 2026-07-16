#pragma once

#include <memory>
#include <string>
#include <vector>

#include "desktop_translate/native/capture/screen_capture.h"
#include "desktop_translate/native/core/error.h"
#include "desktop_translate/native/core/types.h"

namespace desktop_translate::native {

struct OcrLine {
  std::string text_utf8;
  // Pixel coordinates local to the supplied bitmap. The pipeline translates
  // them to physical desktop coordinates before emitting IPC.
  PhysicalRect bounds;
  float confidence{};
};

struct OcrResult {
  ErrorCode error{ErrorCode::kOcrUnavailable};
  std::vector<OcrLine> lines;
  std::string detail;

  [[nodiscard]] bool ok() const noexcept { return error == ErrorCode::kOk; }
};

class IOcrEngine {
 public:
  virtual ~IOcrEngine() = default;
  [[nodiscard]] virtual bool available() const noexcept = 0;
  [[nodiscard]] virtual std::string name() const = 0;
  // Concrete runtimes must return by timeout_ms; the host never kills an OCR
  // thread because doing so is unsafe for inference libraries.
  [[nodiscard]] virtual OcrResult Recognize(const CapturedBitmap& bitmap,
                                            std::uint32_t timeout_ms) = 0;
};

}  // namespace desktop_translate::native
