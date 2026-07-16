#pragma once

#include "desktop_translate/native/capture/screen_capture.h"

namespace desktop_translate::native {

// Stateless Phase-1 probe implementation. Each call creates a duplication
// session for the output containing the ROI center. Phase 3 may add safe cache
// invalidation for display changes and DXGI_ERROR_ACCESS_LOST.
class DesktopDuplicationCapture final : public IScreenCapture {
 public:
  [[nodiscard]] CaptureResult CaptureRoi(PhysicalRect roi,
                                          std::uint32_t timeout_ms) override;
};

}  // namespace desktop_translate::native
