#include "desktop_translate/native/core/frame_codec.h"

#include <limits>
#include <stdexcept>

namespace desktop_translate::native {

std::vector<std::uint8_t> EncodeFrame(std::string_view json) {
  if (json.size() > kMaximumFrameBytes ||
      json.size() > std::numeric_limits<std::uint32_t>::max()) {
    throw std::length_error("native IPC frame exceeds the maximum size");
  }

  const auto size = static_cast<std::uint32_t>(json.size());
  std::vector<std::uint8_t> frame;
  frame.reserve(sizeof(size) + json.size());
  frame.push_back(static_cast<std::uint8_t>(size & 0xffU));
  frame.push_back(static_cast<std::uint8_t>((size >> 8U) & 0xffU));
  frame.push_back(static_cast<std::uint8_t>((size >> 16U) & 0xffU));
  frame.push_back(static_cast<std::uint8_t>((size >> 24U) & 0xffU));
  frame.insert(frame.end(), json.begin(), json.end());
  return frame;
}

FrameDecodeResult FrameDecoder::Feed(std::span<const std::uint8_t> bytes) {
  if (failure_ != ErrorCode::kOk) {
    return {failure_, {}};
  }

  buffer_.insert(buffer_.end(), bytes.begin(), bytes.end());
  FrameDecodeResult result;
  std::size_t offset = 0;

  while (buffer_.size() - offset >= sizeof(std::uint32_t)) {
    const auto length = static_cast<std::uint32_t>(buffer_[offset]) |
                        (static_cast<std::uint32_t>(buffer_[offset + 1]) << 8U) |
                        (static_cast<std::uint32_t>(buffer_[offset + 2]) << 16U) |
                        (static_cast<std::uint32_t>(buffer_[offset + 3]) << 24U);
    if (length == 0U) {
      failure_ = ErrorCode::kMalformedFrame;
      return {failure_, {}};
    }
    if (length > maximum_frame_bytes_) {
      failure_ = ErrorCode::kFrameTooLarge;
      return {failure_, {}};
    }

    const auto full_size = sizeof(std::uint32_t) + static_cast<std::size_t>(length);
    if (buffer_.size() - offset < full_size) {
      break;
    }

    const auto payload_begin = buffer_.begin() + static_cast<std::ptrdiff_t>(offset + 4U);
    result.frames.emplace_back(payload_begin,
                               payload_begin + static_cast<std::ptrdiff_t>(length));
    offset += full_size;
  }

  if (offset != 0U) {
    buffer_.erase(buffer_.begin(), buffer_.begin() + static_cast<std::ptrdiff_t>(offset));
  }
  return result;
}

void FrameDecoder::Reset() noexcept {
  buffer_.clear();
  failure_ = ErrorCode::kOk;
}

}  // namespace desktop_translate::native
