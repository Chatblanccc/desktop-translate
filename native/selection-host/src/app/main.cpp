#include <Windows.h>

#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <cwchar>
#include <iostream>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "desktop_translate/native/app/selection_host_app.h"

namespace dt = desktop_translate::native;

namespace {

struct ParsedArguments {
  std::wstring pipe;
  std::uint32_t parent_pid{};
  std::string nonce;
};

std::optional<std::uint32_t> ParsePid(const wchar_t* value) {
  if (value == nullptr || *value == L'\0' || *value == L'-') return std::nullopt;
  wchar_t* end = nullptr;
  errno = 0;
  const auto parsed = std::wcstoull(value, &end, 10);
  if (errno != 0 || end == value || *end != L'\0' || parsed == 0U ||
      parsed > std::numeric_limits<std::uint32_t>::max()) {
    return std::nullopt;
  }
  return static_cast<std::uint32_t>(parsed);
}

std::optional<std::string> ParseHexNonce(const std::wstring& value) {
  if (value.size() < 32U || value.size() > 256U) return std::nullopt;
  std::string nonce;
  nonce.reserve(value.size());
  for (const wchar_t c : value) {
    const bool hex = (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') ||
                     (c >= L'A' && c <= L'F');
    if (!hex) return std::nullopt;
    nonce.push_back(static_cast<char>(c));
  }
  return nonce;
}

std::optional<ParsedArguments> ParseArguments(int argc, wchar_t** argv) {
  ParsedArguments result;
  std::wstring nonce_wide;
  for (int index = 1; index < argc; ++index) {
    const std::wstring argument = argv[index];
    if (index + 1 >= argc) return std::nullopt;
    if (argument == L"--pipe" && result.pipe.empty()) {
      result.pipe = argv[++index];
    } else if (argument == L"--parent-pid" && result.parent_pid == 0U) {
      const auto pid = ParsePid(argv[++index]);
      if (!pid) return std::nullopt;
      result.parent_pid = *pid;
    } else if (argument == L"--nonce" && nonce_wide.empty()) {
      nonce_wide = argv[++index];
    } else {
      return std::nullopt;
    }
  }

  constexpr std::wstring_view kPipePrefix =
      L"\\\\.\\pipe\\desktop-translate.selection-host.";
  const auto nonce = ParseHexNonce(nonce_wide);
  const auto expected_pipe = std::wstring(kPipePrefix) + std::to_wstring(result.parent_pid) +
                             L"." + nonce_wide;
  if (result.pipe.size() > 256U || !result.pipe.starts_with(kPipePrefix) ||
      result.parent_pid == 0U || result.parent_pid == GetCurrentProcessId() || !nonce ||
      result.pipe != expected_pipe) {
    return std::nullopt;
  }
  result.nonce = *nonce;
  return result;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  (void)SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  const auto arguments = ParseArguments(argc, argv);
  if (!arguments) {
    std::wcerr << L"usage: selection-host --pipe <full-name> --parent-pid <pid> "
                  L"--nonce <32-256 hex chars>\n";
    return 2;
  }

  dt::SelectionHostOptions options;
  options.pipe_name = arguments->pipe;
  options.parent_pid = arguments->parent_pid;
  options.session_nonce = arguments->nonce;
  dt::SelectionHostApp app(std::move(options));
  return app.Run();
}
