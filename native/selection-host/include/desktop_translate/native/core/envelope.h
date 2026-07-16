#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "desktop_translate/native/core/error.h"

namespace desktop_translate::native {

enum class MessageKind { kRequest, kResponse, kEvent };

struct Envelope {
  std::int32_t version{1};
  MessageKind kind{MessageKind::kRequest};
  std::optional<std::string> id;
  std::optional<std::uint64_t> sequence;
  std::string method;
  std::string timestamp;
  std::string payload_json{"{}"};
};

struct EnvelopeDecodeResult {
  ErrorCode error{ErrorCode::kOk};
  Envelope envelope;
  std::string detail;
};

[[nodiscard]] EnvelopeDecodeResult DecodeEnvelope(std::string_view json);
[[nodiscard]] std::string EncodeEnvelope(const Envelope& envelope);
[[nodiscard]] std::string EscapeJsonString(std::string_view value);
[[nodiscard]] std::optional<std::string> FindJsonStringField(
    std::string_view object_json, std::string_view field);
[[nodiscard]] std::optional<bool> FindJsonBoolField(
    std::string_view object_json, std::string_view field);
[[nodiscard]] std::optional<std::uint64_t> FindJsonUnsignedField(
    std::string_view object_json, std::string_view field);
[[nodiscard]] std::optional<double> FindJsonNumberField(
    std::string_view object_json, std::string_view field);
[[nodiscard]] std::optional<std::vector<std::string>> FindJsonStringArrayField(
    std::string_view object_json, std::string_view field);
[[nodiscard]] std::optional<std::vector<std::uint64_t>> FindJsonUnsignedArrayField(
    std::string_view object_json, std::string_view field);
[[nodiscard]] bool JsonObjectHasField(std::string_view object_json,
                                      std::string_view field);
[[nodiscard]] bool JsonObjectHasOnlyFields(
    std::string_view object_json, std::span<const std::string_view> allowed_fields);

}  // namespace desktop_translate::native
