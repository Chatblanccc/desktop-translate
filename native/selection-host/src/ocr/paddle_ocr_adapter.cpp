#include "desktop_translate/native/ocr/paddle_ocr_adapter.h"

#include <utility>

namespace desktop_translate::native {

PaddleOcrAdapter::PaddleOcrAdapter(std::unique_ptr<IPaddleOcrRuntime> runtime)
    : runtime_(std::move(runtime)) {}

PaddleOcrAdapter::~PaddleOcrAdapter() = default;

bool PaddleOcrAdapter::available() const noexcept {
  return runtime_ != nullptr && runtime_->available();
}

std::string PaddleOcrAdapter::name() const { return "paddleocr"; }

OcrResult PaddleOcrAdapter::Recognize(const CapturedBitmap& bitmap,
                                      std::uint32_t timeout_ms) {
  if (!available()) {
    return {ErrorCode::kOcrUnavailable, {},
            "PaddleOCR runtime is not linked; OCR was not attempted"};
  }
  if (bitmap.width == 0U || bitmap.height == 0U || bitmap.pixels.empty()) {
    return {ErrorCode::kInvalidArgument, {}, "OCR bitmap is empty"};
  }
  if (timeout_ms == 0U) {
    return {ErrorCode::kInvalidArgument, {}, "OCR timeout must be positive"};
  }
  return runtime_->RunBgra(bitmap, timeout_ms);
}

std::unique_ptr<IOcrEngine> CreatePaddleOcrAdapter() {
  // A concrete IPaddleOcrRuntime is deliberately not fabricated. Until the
  // separately licensed/runtime dependency is linked, available() is false and
  // Recognize returns ocr_unavailable.
  return std::make_unique<PaddleOcrAdapter>();
}

}  // namespace desktop_translate::native
