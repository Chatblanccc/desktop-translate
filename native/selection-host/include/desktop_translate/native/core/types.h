#pragma once

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

#include "desktop_translate/native/core/error.h"

namespace desktop_translate::native {

// All coordinates crossing the native boundary are physical desktop pixels.
// Electron Main is solely responsible for converting these values to DIP.
struct PhysicalPoint {
  std::int32_t x{};
  std::int32_t y{};
};

struct PhysicalRect {
  std::int32_t x{};
  std::int32_t y{};
  std::int32_t width{};
  std::int32_t height{};

  [[nodiscard]] bool IsEmpty() const noexcept { return width <= 0 || height <= 0; }
  [[nodiscard]] std::int32_t Right() const noexcept { return x + width; }
  [[nodiscard]] std::int32_t Bottom() const noexcept { return y + height; }
};

[[nodiscard]] inline PhysicalRect RectFromPoints(PhysicalPoint a, PhysicalPoint b,
                                                 std::int32_t padding = 0) noexcept {
  const auto left = std::min(a.x, b.x) - padding;
  const auto top = std::min(a.y, b.y) - padding;
  const auto right = std::max(a.x, b.x) + padding;
  const auto bottom = std::max(a.y, b.y) + padding;
  return {left, top, std::max<std::int32_t>(1, right - left),
          std::max<std::int32_t>(1, bottom - top)};
}

struct TextSelection {
  std::string text_utf8;
  std::vector<PhysicalRect> bounds;
};

struct SelectionResult {
  ErrorCode error{ErrorCode::kInternalError};
  TextSelection selection;
  std::string detail;

  [[nodiscard]] bool ok() const noexcept { return error == ErrorCode::kOk; }
};

}  // namespace desktop_translate::native
