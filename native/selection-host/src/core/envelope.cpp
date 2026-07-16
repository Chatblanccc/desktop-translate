#include "desktop_translate/native/core/envelope.h"

#include <algorithm>
#include <charconv>
#include <cctype>
#include <limits>
#include <unordered_map>

#include "desktop_translate/native/core/utf8.h"

namespace desktop_translate::native {
namespace {

using FieldMap = std::unordered_map<std::string, std::string_view>;

void SkipWhitespace(std::string_view input, std::size_t& cursor) {
  while (cursor < input.size() &&
         std::isspace(static_cast<unsigned char>(input[cursor])) != 0) {
    ++cursor;
  }
}

void AppendUtf8(std::string& output, std::uint32_t code_point) {
  if (code_point <= 0x7fU) {
    output.push_back(static_cast<char>(code_point));
  } else if (code_point <= 0x7ffU) {
    output.push_back(static_cast<char>(0xc0U | (code_point >> 6U)));
    output.push_back(static_cast<char>(0x80U | (code_point & 0x3fU)));
  } else if (code_point <= 0xffffU) {
    output.push_back(static_cast<char>(0xe0U | (code_point >> 12U)));
    output.push_back(static_cast<char>(0x80U | ((code_point >> 6U) & 0x3fU)));
    output.push_back(static_cast<char>(0x80U | (code_point & 0x3fU)));
  } else {
    output.push_back(static_cast<char>(0xf0U | (code_point >> 18U)));
    output.push_back(static_cast<char>(0x80U | ((code_point >> 12U) & 0x3fU)));
    output.push_back(static_cast<char>(0x80U | ((code_point >> 6U) & 0x3fU)));
    output.push_back(static_cast<char>(0x80U | (code_point & 0x3fU)));
  }
}

bool ParseHex4(std::string_view input, std::size_t cursor, std::uint32_t& value) {
  if (cursor + 4U > input.size()) return false;
  value = 0;
  for (std::size_t i = 0; i < 4U; ++i) {
    const char c = input[cursor + i];
    value <<= 4U;
    if (c >= '0' && c <= '9') value |= static_cast<std::uint32_t>(c - '0');
    else if (c >= 'a' && c <= 'f') value |= static_cast<std::uint32_t>(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') value |= static_cast<std::uint32_t>(c - 'A' + 10);
    else return false;
  }
  return true;
}

bool ParseString(std::string_view input, std::size_t& cursor, std::string& output) {
  if (cursor >= input.size() || input[cursor] != '"') return false;
  ++cursor;
  output.clear();
  while (cursor < input.size()) {
    const char c = input[cursor++];
    if (c == '"') return true;
    if (static_cast<unsigned char>(c) < 0x20U) return false;
    if (c != '\\') {
      output.push_back(c);
      continue;
    }
    if (cursor >= input.size()) return false;
    switch (input[cursor++]) {
      case '"': output.push_back('"'); break;
      case '\\': output.push_back('\\'); break;
      case '/': output.push_back('/'); break;
      case 'b': output.push_back('\b'); break;
      case 'f': output.push_back('\f'); break;
      case 'n': output.push_back('\n'); break;
      case 'r': output.push_back('\r'); break;
      case 't': output.push_back('\t'); break;
      case 'u': {
        std::uint32_t first = 0;
        if (!ParseHex4(input, cursor, first)) return false;
        cursor += 4U;
        std::uint32_t code_point = first;
        if (first >= 0xd800U && first <= 0xdbffU) {
          if (cursor + 6U > input.size() || input[cursor] != '\\' ||
              input[cursor + 1U] != 'u') return false;
          cursor += 2U;
          std::uint32_t second = 0;
          if (!ParseHex4(input, cursor, second) || second < 0xdc00U || second > 0xdfffU) {
            return false;
          }
          cursor += 4U;
          code_point = 0x10000U + ((first - 0xd800U) << 10U) + (second - 0xdc00U);
        } else if (first >= 0xdc00U && first <= 0xdfffU) {
          return false;
        }
        AppendUtf8(output, code_point);
        break;
      }
      default: return false;
    }
  }
  return false;
}

bool FindValueEnd(std::string_view input, std::size_t start, std::size_t& end) {
  const auto ConsumeValue = [&](auto&& self, std::size_t& cursor,
                                std::size_t depth) -> bool {
    if (depth > 64U) return false;
    SkipWhitespace(input, cursor);
    if (cursor >= input.size()) return false;
    if (input[cursor] == '"') {
      std::string ignored;
      return ParseString(input, cursor, ignored);
    }
    if (input[cursor] == '{') {
      ++cursor;
      SkipWhitespace(input, cursor);
      if (cursor < input.size() && input[cursor] == '}') {
        ++cursor;
        return true;
      }
      for (;;) {
        std::string key;
        if (!ParseString(input, cursor, key)) return false;
        SkipWhitespace(input, cursor);
        if (cursor >= input.size() || input[cursor++] != ':') return false;
        if (!self(self, cursor, depth + 1U)) return false;
        SkipWhitespace(input, cursor);
        if (cursor >= input.size()) return false;
        if (input[cursor] == '}') {
          ++cursor;
          return true;
        }
        if (input[cursor++] != ',') return false;
        SkipWhitespace(input, cursor);
      }
    }
    if (input[cursor] == '[') {
      ++cursor;
      SkipWhitespace(input, cursor);
      if (cursor < input.size() && input[cursor] == ']') {
        ++cursor;
        return true;
      }
      for (;;) {
        if (!self(self, cursor, depth + 1U)) return false;
        SkipWhitespace(input, cursor);
        if (cursor >= input.size()) return false;
        if (input[cursor] == ']') {
          ++cursor;
          return true;
        }
        if (input[cursor++] != ',') return false;
        SkipWhitespace(input, cursor);
      }
    }
    for (const auto literal : {std::string_view("true"), std::string_view("false"),
                               std::string_view("null")}) {
      if (input.substr(cursor, literal.size()) == literal) {
        cursor += literal.size();
        return true;
      }
    }

    const auto number_start = cursor;
    if (input[cursor] == '-') ++cursor;
    if (cursor >= input.size()) return false;
    if (input[cursor] == '0') {
      ++cursor;
      if (cursor < input.size() && std::isdigit(static_cast<unsigned char>(input[cursor])) != 0) {
        return false;
      }
    } else {
      if (input[cursor] < '1' || input[cursor] > '9') return false;
      while (cursor < input.size() &&
             std::isdigit(static_cast<unsigned char>(input[cursor])) != 0) ++cursor;
    }
    if (cursor < input.size() && input[cursor] == '.') {
      ++cursor;
      const auto fraction_start = cursor;
      while (cursor < input.size() &&
             std::isdigit(static_cast<unsigned char>(input[cursor])) != 0) ++cursor;
      if (cursor == fraction_start) return false;
    }
    if (cursor < input.size() && (input[cursor] == 'e' || input[cursor] == 'E')) {
      ++cursor;
      if (cursor < input.size() && (input[cursor] == '+' || input[cursor] == '-')) ++cursor;
      const auto exponent_start = cursor;
      while (cursor < input.size() &&
             std::isdigit(static_cast<unsigned char>(input[cursor])) != 0) ++cursor;
      if (cursor == exponent_start) return false;
    }
    return cursor > number_start;
  };

  auto cursor = start;
  if (!ConsumeValue(ConsumeValue, cursor, 0U)) return false;
  end = cursor;
  return true;
}

bool ParseObject(std::string_view input, FieldMap& fields) {
  std::size_t cursor = 0;
  SkipWhitespace(input, cursor);
  if (cursor >= input.size() || input[cursor++] != '{') return false;
  SkipWhitespace(input, cursor);
  if (cursor < input.size() && input[cursor] == '}') {
    ++cursor;
    SkipWhitespace(input, cursor);
    return cursor == input.size();
  }

  while (cursor < input.size()) {
    std::string key;
    if (!ParseString(input, cursor, key)) return false;
    SkipWhitespace(input, cursor);
    if (cursor >= input.size() || input[cursor++] != ':') return false;
    SkipWhitespace(input, cursor);
    const auto value_start = cursor;
    std::size_t value_end = cursor;
    if (!FindValueEnd(input, value_start, value_end)) return false;
    if (!fields.emplace(std::move(key), input.substr(value_start, value_end - value_start)).second) {
      return false;
    }
    cursor = value_end;
    SkipWhitespace(input, cursor);
    if (cursor >= input.size()) return false;
    if (input[cursor] == '}') {
      ++cursor;
      SkipWhitespace(input, cursor);
      return cursor == input.size();
    }
    if (input[cursor++] != ',') return false;
    SkipWhitespace(input, cursor);
  }
  return false;
}

std::optional<std::string> DecodeStringValue(std::string_view raw) {
  std::size_t cursor = 0;
  std::string decoded;
  if (!ParseString(raw, cursor, decoded)) return std::nullopt;
  SkipWhitespace(raw, cursor);
  if (cursor != raw.size()) return std::nullopt;
  return decoded;
}

template <typename Integer>
bool ParseInteger(std::string_view raw, Integer& output) {
  const auto begin = raw.data();
  const auto end = raw.data() + raw.size();
  const auto result = std::from_chars(begin, end, output);
  return result.ec == std::errc{} && result.ptr == end;
}

std::optional<MessageKind> ParseKind(std::string_view raw) {
  const auto decoded = DecodeStringValue(raw);
  if (!decoded) return std::nullopt;
  if (*decoded == "request") return MessageKind::kRequest;
  if (*decoded == "response") return MessageKind::kResponse;
  if (*decoded == "event") return MessageKind::kEvent;
  return std::nullopt;
}

bool IsRfc3339Timestamp(std::string_view value) {
  const auto IsDigit = [&](std::size_t index) {
    return index < value.size() && value[index] >= '0' && value[index] <= '9';
  };
  const auto Number = [&](std::size_t index, std::size_t count) {
    int result = 0;
    for (std::size_t offset = 0; offset < count; ++offset) {
      if (!IsDigit(index + offset)) return -1;
      result = result * 10 + (value[index + offset] - '0');
    }
    return result;
  };
  if (value.size() < 20U || value.size() > 64U || value[4] != '-' || value[7] != '-' ||
      value[10] != 'T' || value[13] != ':' || value[16] != ':') {
    return false;
  }
  const int year = Number(0U, 4U);
  const int month = Number(5U, 2U);
  const int day = Number(8U, 2U);
  const int hour = Number(11U, 2U);
  const int minute = Number(14U, 2U);
  const int second = Number(17U, 2U);
  if (year <= 0 || month < 1 || month > 12 || hour < 0 || hour > 23 || minute < 0 ||
      minute > 59 || second < 0 || second > 59) {
    return false;
  }
  const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
  constexpr int kDays[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  const int maximum_day = month == 2 && leap ? 29 : kDays[month - 1];
  if (day < 1 || day > maximum_day) return false;

  std::size_t cursor = 19U;
  if (cursor < value.size() && value[cursor] == '.') {
    ++cursor;
    const auto fraction_start = cursor;
    while (cursor < value.size() && IsDigit(cursor)) ++cursor;
    if (cursor == fraction_start) return false;
  }
  if (cursor >= value.size()) return false;
  if (value[cursor] == 'Z') return cursor + 1U == value.size();
  if (value[cursor] != '+' && value[cursor] != '-') return false;
  if (cursor + 6U != value.size() || value[cursor + 3U] != ':') return false;
  const int offset_hour = Number(cursor + 1U, 2U);
  const int offset_minute = Number(cursor + 4U, 2U);
  return offset_hour >= 0 && offset_hour <= 23 && offset_minute >= 0 && offset_minute <= 59;
}

std::string_view KindString(MessageKind kind) {
  switch (kind) {
    case MessageKind::kRequest: return "request";
    case MessageKind::kResponse: return "response";
    case MessageKind::kEvent: return "event";
  }
  return "event";
}

}  // namespace

EnvelopeDecodeResult DecodeEnvelope(std::string_view json) {
  if (!IsValidUtf8(json)) {
    return {ErrorCode::kMalformedJson, {}, "envelope is not valid UTF-8"};
  }
  FieldMap fields;
  if (!ParseObject(json, fields)) {
    return {ErrorCode::kMalformedJson, {}, "expected a unique-key JSON object"};
  }

  const auto version_it = fields.find("v");
  const auto kind_it = fields.find("kind");
  const auto method_it = fields.find("method");
  const auto timestamp_it = fields.find("timestamp");
  const auto payload_it = fields.find("payload");
  if (version_it == fields.end() || kind_it == fields.end() || method_it == fields.end() ||
      timestamp_it == fields.end() || payload_it == fields.end()) {
    return {ErrorCode::kMalformedJson, {}, "missing required envelope field"};
  }

  Envelope envelope;
  if (!ParseInteger(version_it->second, envelope.version)) {
    return {ErrorCode::kMalformedJson, {}, "v must be an integer"};
  }
  if (envelope.version != 1) {
    return {ErrorCode::kUnsupportedProtocol, {}, "only protocol v1 is supported"};
  }
  const auto kind = ParseKind(kind_it->second);
  if (!kind) return {ErrorCode::kMalformedJson, {}, "invalid message kind"};
  envelope.kind = *kind;

  for (const auto& [field, ignored] : fields) {
    (void)ignored;
    if (field != "v" && field != "kind" && field != "id" && field != "seq" &&
        field != "method" && field != "timestamp" && field != "payload") {
      return {ErrorCode::kMalformedJson, {}, "unknown envelope field"};
    }
  }

  const auto method = DecodeStringValue(method_it->second);
  const auto timestamp = DecodeStringValue(timestamp_it->second);
  if (!method || method->empty() || method->size() > 64U || !timestamp ||
      !IsRfc3339Timestamp(*timestamp)) {
    return {ErrorCode::kMalformedJson, {}, "method and timestamp must be non-empty strings"};
  }
  envelope.method = *method;
  envelope.timestamp = *timestamp;

  const auto payload = payload_it->second;
  std::size_t payload_cursor = 0;
  SkipWhitespace(payload, payload_cursor);
  if (payload_cursor >= payload.size() || payload[payload_cursor] != '{') {
    return {ErrorCode::kMalformedJson, {}, "payload must be an object"};
  }
  FieldMap payload_validation;
  if (!ParseObject(payload, payload_validation)) {
    return {ErrorCode::kMalformedJson, {}, "payload must be a valid object"};
  }
  envelope.payload_json.assign(payload);

  if (const auto id_it = fields.find("id"); id_it != fields.end()) {
    const auto id = DecodeStringValue(id_it->second);
    const bool valid_id = id && !id->empty() && id->size() <= 128U &&
        std::all_of(id->begin(), id->end(), [](unsigned char c) {
          return std::isalnum(c) != 0 || c == '.' || c == '_' || c == ':' || c == '-';
        }) && std::isalnum(static_cast<unsigned char>((*id)[0])) != 0;
    if (!valid_id) return {ErrorCode::kMalformedJson, {}, "id is invalid"};
    envelope.id = *id;
  }
  if (const auto seq_it = fields.find("seq"); seq_it != fields.end()) {
    std::uint64_t seq = 0;
    if (!ParseInteger(seq_it->second, seq)) {
      return {ErrorCode::kMalformedJson, {}, "seq must be an unsigned integer"};
    }
    envelope.sequence = seq;
  }
  if ((envelope.kind == MessageKind::kRequest || envelope.kind == MessageKind::kResponse) &&
      (!envelope.id || envelope.sequence)) {
    return {ErrorCode::kMalformedJson, {}, "request/response requires id and forbids seq"};
  }
  if (envelope.kind == MessageKind::kEvent && (!envelope.sequence || envelope.id)) {
    return {ErrorCode::kMalformedJson, {}, "event requires seq and forbids id"};
  }
  return {ErrorCode::kOk, std::move(envelope), {}};
}

std::string EscapeJsonString(std::string_view value) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string result;
  result.reserve(value.size() + 2U);
  for (const unsigned char c : value) {
    switch (c) {
      case '"': result += "\\\""; break;
      case '\\': result += "\\\\"; break;
      case '\b': result += "\\b"; break;
      case '\f': result += "\\f"; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (c < 0x20U) {
          result += "\\u00";
          result.push_back(kHex[(c >> 4U) & 0x0fU]);
          result.push_back(kHex[c & 0x0fU]);
        } else {
          result.push_back(static_cast<char>(c));
        }
    }
  }
  return result;
}

std::string EncodeEnvelope(const Envelope& envelope) {
  std::string json = "{\"v\":" + std::to_string(envelope.version) +
                     ",\"kind\":\"" + std::string(KindString(envelope.kind)) + "\"";
  if (envelope.id) json += ",\"id\":\"" + EscapeJsonString(*envelope.id) + "\"";
  if (envelope.sequence) json += ",\"seq\":" + std::to_string(*envelope.sequence);
  json += ",\"method\":\"" + EscapeJsonString(envelope.method) + "\"";
  json += ",\"timestamp\":\"" + EscapeJsonString(envelope.timestamp) + "\"";
  json += ",\"payload\":" + (envelope.payload_json.empty() ? "{}" : envelope.payload_json);
  json += '}';
  return json;
}

std::optional<std::string> FindJsonStringField(std::string_view object_json,
                                               std::string_view field) {
  FieldMap fields;
  if (!ParseObject(object_json, fields)) return std::nullopt;
  const auto it = fields.find(std::string(field));
  if (it == fields.end()) return std::nullopt;
  return DecodeStringValue(it->second);
}

std::optional<bool> FindJsonBoolField(std::string_view object_json, std::string_view field) {
  FieldMap fields;
  if (!ParseObject(object_json, fields)) return std::nullopt;
  const auto it = fields.find(std::string(field));
  if (it == fields.end()) return std::nullopt;
  if (it->second == "true") return true;
  if (it->second == "false") return false;
  return std::nullopt;
}

std::optional<std::uint64_t> FindJsonUnsignedField(std::string_view object_json,
                                                  std::string_view field) {
  FieldMap fields;
  if (!ParseObject(object_json, fields)) return std::nullopt;
  const auto it = fields.find(std::string(field));
  if (it == fields.end()) return std::nullopt;
  std::uint64_t value = 0;
  if (!ParseInteger(it->second, value)) return std::nullopt;
  return value;
}

std::optional<double> FindJsonNumberField(std::string_view object_json,
                                         std::string_view field) {
  FieldMap fields;
  if (!ParseObject(object_json, fields)) return std::nullopt;
  const auto it = fields.find(std::string(field));
  if (it == fields.end()) return std::nullopt;
  double value = 0.0;
  if (!ParseInteger(it->second, value)) return std::nullopt;
  return value;
}

std::optional<std::vector<std::string>> FindJsonStringArrayField(
    std::string_view object_json, std::string_view field) {
  FieldMap fields;
  if (!ParseObject(object_json, fields)) return std::nullopt;
  const auto it = fields.find(std::string(field));
  if (it == fields.end()) return std::nullopt;
  const auto raw = it->second;
  std::size_t cursor = 0;
  SkipWhitespace(raw, cursor);
  if (cursor >= raw.size() || raw[cursor++] != '[') return std::nullopt;
  SkipWhitespace(raw, cursor);
  std::vector<std::string> values;
  if (cursor < raw.size() && raw[cursor] == ']') {
    ++cursor;
    SkipWhitespace(raw, cursor);
    if (cursor == raw.size()) return values;
    return std::nullopt;
  }
  for (;;) {
    std::string value;
    if (!ParseString(raw, cursor, value)) return std::nullopt;
    values.push_back(std::move(value));
    SkipWhitespace(raw, cursor);
    if (cursor >= raw.size()) return std::nullopt;
    if (raw[cursor] == ']') {
      ++cursor;
      SkipWhitespace(raw, cursor);
      if (cursor == raw.size()) return values;
      return std::nullopt;
    }
    if (raw[cursor++] != ',') return std::nullopt;
    SkipWhitespace(raw, cursor);
  }
}

std::optional<std::vector<std::uint64_t>> FindJsonUnsignedArrayField(
    std::string_view object_json, std::string_view field) {
  FieldMap fields;
  if (!ParseObject(object_json, fields)) return std::nullopt;
  const auto it = fields.find(std::string(field));
  if (it == fields.end()) return std::nullopt;
  const auto raw = it->second;
  std::size_t cursor = 0;
  SkipWhitespace(raw, cursor);
  if (cursor >= raw.size() || raw[cursor++] != '[') return std::nullopt;
  SkipWhitespace(raw, cursor);
  std::vector<std::uint64_t> values;
  if (cursor < raw.size() && raw[cursor] == ']') {
    ++cursor;
    SkipWhitespace(raw, cursor);
    if (cursor == raw.size()) return values;
    return std::nullopt;
  }
  for (;;) {
    const auto value_start = cursor;
    while (cursor < raw.size() &&
           std::isdigit(static_cast<unsigned char>(raw[cursor])) != 0) ++cursor;
    if (cursor == value_start) return std::nullopt;
    std::uint64_t value = 0;
    if (!ParseInteger(raw.substr(value_start, cursor - value_start), value)) return std::nullopt;
    values.push_back(value);
    SkipWhitespace(raw, cursor);
    if (cursor >= raw.size()) return std::nullopt;
    if (raw[cursor] == ']') {
      ++cursor;
      SkipWhitespace(raw, cursor);
      if (cursor == raw.size()) return values;
      return std::nullopt;
    }
    if (raw[cursor++] != ',') return std::nullopt;
    SkipWhitespace(raw, cursor);
  }
}

bool JsonObjectHasField(std::string_view object_json, std::string_view field) {
  FieldMap fields;
  return ParseObject(object_json, fields) && fields.contains(std::string(field));
}

bool JsonObjectHasOnlyFields(std::string_view object_json,
                             std::span<const std::string_view> allowed_fields) {
  FieldMap fields;
  if (!ParseObject(object_json, fields)) return false;
  return std::all_of(fields.begin(), fields.end(), [&](const auto& entry) {
    return std::find(allowed_fields.begin(), allowed_fields.end(), entry.first) !=
           allowed_fields.end();
  });
}

}  // namespace desktop_translate::native
