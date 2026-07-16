#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <vector>

#include "desktop_translate/native/core/error.h"

namespace desktop_translate::native {

inline constexpr std::uint32_t kMaximumFrameBytes = 1024U * 1024U;

struct FrameDecodeResult {
  ErrorCode error{ErrorCode::kOk};
  std::vector<std::string> frames;
};

[[nodiscard]] std::vector<std::uint8_t> EncodeFrame(std::string_view json);

class FrameDecoder {
 public:
  explicit FrameDecoder(std::uint32_t maximum_frame_bytes = kMaximumFrameBytes)
      : maximum_frame_bytes_(maximum_frame_bytes) {}

  [[nodiscard]] FrameDecodeResult Feed(std::span<const std::uint8_t> bytes);
  void Reset() noexcept;

 private:
  std::uint32_t maximum_frame_bytes_;
  std::vector<std::uint8_t> buffer_;
  ErrorCode failure_{ErrorCode::kOk};
};

}  // namespace desktop_translate::native
