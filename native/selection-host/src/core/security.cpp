#include "desktop_translate/native/core/security.h"

#include <cstdint>

namespace desktop_translate::native {

bool ConstantTimeEquals(std::string_view first, std::string_view second) noexcept {
  if (first.size() != second.size()) return false;
  std::uint8_t difference = 0U;
  for (std::size_t index = 0; index < first.size(); ++index) {
    difference |= static_cast<std::uint8_t>(first[index]) ^
                  static_cast<std::uint8_t>(second[index]);
  }
  return difference == 0U;
}

}  // namespace desktop_translate::native
