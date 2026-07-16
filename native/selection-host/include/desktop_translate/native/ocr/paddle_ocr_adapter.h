#pragma once

#include <memory>

#include "desktop_translate/native/ocr/ocr_engine.h"

namespace desktop_translate::native {

// This is the only boundary that may include/link PaddleOCR in a future adapter
// target. The selection host and its tests intentionally do not include Paddle
// headers. A real runtime must return available()==true and actual OCR results.
class IPaddleOcrRuntime {
 public:
  virtual ~IPaddleOcrRuntime() = default;
  [[nodiscard]] virtual bool available() const noexcept = 0;
  [[nodiscard]] virtual OcrResult RunBgra(const CapturedBitmap& bitmap,
                                          std::uint32_t timeout_ms) = 0;
};

class PaddleOcrAdapter final : public IOcrEngine {
 public:
  explicit PaddleOcrAdapter(std::unique_ptr<IPaddleOcrRuntime> runtime = {});
  ~PaddleOcrAdapter() override;

  [[nodiscard]] bool available() const noexcept override;
  [[nodiscard]] std::string name() const override;
  [[nodiscard]] OcrResult Recognize(const CapturedBitmap& bitmap,
                                    std::uint32_t timeout_ms) override;

 private:
  std::unique_ptr<IPaddleOcrRuntime> runtime_;
};

[[nodiscard]] std::unique_ptr<IOcrEngine> CreatePaddleOcrAdapter();

}  // namespace desktop_translate::native
