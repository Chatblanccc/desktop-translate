#include "desktop_translate/native/coordinates/coordinates.h"

#include <Windows.h>

#include <algorithm>
#include <cstdint>

namespace desktop_translate::native {

PhysicalRect VirtualDesktopBounds() noexcept {
  return {GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
          GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN)};
}

PhysicalRect IntersectRects(PhysicalRect first, PhysicalRect second) noexcept {
  const auto left = std::max<std::int64_t>(first.x, second.x);
  const auto top = std::max<std::int64_t>(first.y, second.y);
  const auto right = std::min<std::int64_t>(static_cast<std::int64_t>(first.x) + first.width,
                                            static_cast<std::int64_t>(second.x) + second.width);
  const auto bottom = std::min<std::int64_t>(static_cast<std::int64_t>(first.y) + first.height,
                                             static_cast<std::int64_t>(second.y) + second.height);
  if (right <= left || bottom <= top) return {};
  return {static_cast<std::int32_t>(left), static_cast<std::int32_t>(top),
          static_cast<std::int32_t>(right - left), static_cast<std::int32_t>(bottom - top)};
}

PhysicalRect ClampToVirtualDesktop(PhysicalRect rect) noexcept {
  return IntersectRects(rect, VirtualDesktopBounds());
}

}  // namespace desktop_translate::native
