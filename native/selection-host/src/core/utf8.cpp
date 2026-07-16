#include "desktop_translate/native/core/utf8.h"

#include <cstdint>

namespace desktop_translate::native {
namespace {

struct DecodedCodePoint {
  std::uint32_t value{0xfffdU};
  std::size_t width{1U};
  bool valid{false};
};

bool IsContinuation(unsigned char value) noexcept { return (value & 0xc0U) == 0x80U; }

DecodedCodePoint DecodeOne(std::string_view text, std::size_t cursor) noexcept {
  const auto lead = static_cast<unsigned char>(text[cursor]);
  if (lead <= 0x7fU) return {lead, 1U, true};

  if (lead >= 0xc2U && lead <= 0xdfU && cursor + 1U < text.size()) {
    const auto second = static_cast<unsigned char>(text[cursor + 1U]);
    if (IsContinuation(second)) {
      return {static_cast<std::uint32_t>((lead & 0x1fU) << 6U) | (second & 0x3fU), 2U, true};
    }
  }
  if (lead >= 0xe0U && lead <= 0xefU && cursor + 2U < text.size()) {
    const auto second = static_cast<unsigned char>(text[cursor + 1U]);
    const auto third = static_cast<unsigned char>(text[cursor + 2U]);
    const bool second_valid = IsContinuation(second) &&
        !(lead == 0xe0U && second < 0xa0U) && !(lead == 0xedU && second >= 0xa0U);
    if (second_valid && IsContinuation(third)) {
      const auto value = (static_cast<std::uint32_t>(lead & 0x0fU) << 12U) |
                         (static_cast<std::uint32_t>(second & 0x3fU) << 6U) |
                         (third & 0x3fU);
      return {value, 3U, true};
    }
  }
  if (lead >= 0xf0U && lead <= 0xf4U && cursor + 3U < text.size()) {
    const auto second = static_cast<unsigned char>(text[cursor + 1U]);
    const auto third = static_cast<unsigned char>(text[cursor + 2U]);
    const auto fourth = static_cast<unsigned char>(text[cursor + 3U]);
    const bool second_valid = IsContinuation(second) &&
        !(lead == 0xf0U && second < 0x90U) && !(lead == 0xf4U && second >= 0x90U);
    if (second_valid && IsContinuation(third) && IsContinuation(fourth)) {
      const auto value = (static_cast<std::uint32_t>(lead & 0x07U) << 18U) |
                         (static_cast<std::uint32_t>(second & 0x3fU) << 12U) |
                         (static_cast<std::uint32_t>(third & 0x3fU) << 6U) |
                         (fourth & 0x3fU);
      return {value, 4U, true};
    }
  }
  return {};
}

}  // namespace

std::string TruncateUtf8ToUtf16Units(std::string_view text, std::size_t maximum_units) {
  std::string result;
  result.reserve(text.size());
  std::size_t cursor = 0;
  std::size_t units = 0;
  while (cursor < text.size()) {
    const auto decoded = DecodeOne(text, cursor);
    const std::size_t needed = decoded.value > 0xffffU ? 2U : 1U;
    if (units + needed > maximum_units) break;
    if (decoded.valid && decoded.value != 0U) {
      result.append(text.substr(cursor, decoded.width));
    } else {
      result.append("\xef\xbf\xbd");
    }
    cursor += decoded.width;
    units += needed;
  }
  return result;
}

std::size_t Utf16CodeUnitLength(std::string_view valid_utf8) noexcept {
  std::size_t cursor = 0;
  std::size_t units = 0;
  while (cursor < valid_utf8.size()) {
    const auto decoded = DecodeOne(valid_utf8, cursor);
    units += decoded.value > 0xffffU ? 2U : 1U;
    cursor += decoded.width;
  }
  return units;
}

bool IsValidUtf8(std::string_view text) noexcept {
  std::size_t cursor = 0;
  while (cursor < text.size()) {
    const auto decoded = DecodeOne(text, cursor);
    if (!decoded.valid) return false;
    cursor += decoded.width;
  }
  return true;
}

}  // namespace desktop_translate::native
