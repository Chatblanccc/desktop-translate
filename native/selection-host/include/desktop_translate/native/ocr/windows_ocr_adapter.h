#pragma once

#include <memory>

#include "desktop_translate/native/ocr/ocr_engine.h"

namespace desktop_translate::native {

class WindowsOcrAdapter final : public IOcrEngine {
 public:
  [[nodiscard]] bool available() const noexcept override;
  [[nodiscard]] std::string name() const override;
  [[nodiscard]] OcrResult Recognize(const CapturedBitmap& bitmap,
                                    std::uint32_t timeout_ms) override;
};

[[nodiscard]] std::unique_ptr<IOcrEngine> CreateWindowsOcrAdapter();

}  // namespace desktop_translate::native
