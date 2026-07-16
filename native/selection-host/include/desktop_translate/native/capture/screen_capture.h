#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "desktop_translate/native/core/error.h"
#include "desktop_translate/native/core/types.h"

namespace desktop_translate::native {

enum class PixelFormat { kBgra8 };

struct CapturedBitmap {
  PhysicalRect desktop_bounds;
  std::uint32_t width{};
  std::uint32_t height{};
  std::uint32_t stride{};
  PixelFormat format{PixelFormat::kBgra8};
  std::vector<std::uint8_t> pixels;
};

struct CaptureResult {
  ErrorCode error{ErrorCode::kInternalError};
  CapturedBitmap bitmap;
  std::string detail;

  [[nodiscard]] bool ok() const noexcept { return error == ErrorCode::kOk; }
};

class IScreenCapture {
 public:
  virtual ~IScreenCapture() = default;
  [[nodiscard]] virtual CaptureResult CaptureRoi(PhysicalRect roi,
                                                  std::uint32_t timeout_ms) = 0;
};

}  // namespace desktop_translate::native
