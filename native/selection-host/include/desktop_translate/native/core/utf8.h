#pragma once

#include <cstddef>
#include <string>
#include <string_view>

namespace desktop_translate::native {

// JavaScript and the IPC contract measure text limits in UTF-16 code units.
// Invalid UTF-8 subsequences and embedded NULs are replaced with U+FFFD so
// emitted JSON strings remain valid and satisfy the IPC text contract.
[[nodiscard]] std::string TruncateUtf8ToUtf16Units(std::string_view text,
                                                   std::size_t maximum_units);
[[nodiscard]] std::size_t Utf16CodeUnitLength(std::string_view valid_utf8) noexcept;
[[nodiscard]] bool IsValidUtf8(std::string_view text) noexcept;

}  // namespace desktop_translate::native
