#pragma once

#include <string_view>

namespace desktop_translate::native {

// Content comparison performs the same number of byte comparisons for all
// equal-length inputs. Nonce length is already public in the per-launch pipe
// name, so a length mismatch may return immediately.
[[nodiscard]] bool ConstantTimeEquals(std::string_view first,
                                      std::string_view second) noexcept;

}  // namespace desktop_translate::native
