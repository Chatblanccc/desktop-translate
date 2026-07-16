#pragma once

#include "desktop_translate/native/core/types.h"

namespace desktop_translate::native {

[[nodiscard]] PhysicalRect VirtualDesktopBounds() noexcept;
[[nodiscard]] PhysicalRect IntersectRects(PhysicalRect first, PhysicalRect second) noexcept;
[[nodiscard]] PhysicalRect ClampToVirtualDesktop(PhysicalRect rect) noexcept;

}  // namespace desktop_translate::native
