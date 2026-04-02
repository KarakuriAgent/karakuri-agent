#!/usr/bin/env bash
# X (Twitter) OAuth 1.0a 3-legged flow
# 別アカウントの Access Token / Access Token Secret を取得するスクリプト
#
# ── 前提: X Developer Portal でのアプリ設定 ──
#
# 1. https://developer.x.com/en/portal/dashboard でアプリを作成/選択
#
# 2. 「User authentication settings」で以下を設定:
#
#    App permissions (アプリの権限):
#      → "Read and write" (投稿・いいね・リポストに必要)
#
#    Type of App (アプリの種類):
#      → "Web App, Automated App or Bot"
#
#    Callback URI / Redirect URL (コールバック URI):
#      → https://localhost/callback
#      ※ PIN-based (oob) フローでは実際にはアクセスされないが、設定が必須
#
#    Website URL (ウェブサイト URL) [必須]:
#      → https://example.com
#      ※ 任意の URL でよい（例: GitHub リポジトリ URL など）
#
# 3. 「Keys and tokens」タブから Consumer Key (API Key) / Consumer Secret (API Secret) を控える
#
# ── 使い方 ──
#
#   ./scripts/x-oauth.sh
#   API Key / API Secret は対話的に入力（シェル履歴や ps に残らない）
#
# 必要なツール: curl, openssl, bash 4+

set -euo pipefail

# ── 依存ツールチェック ──
missing=()
for cmd in curl openssl; do
  if ! command -v "$cmd" &>/dev/null; then
    missing+=("$cmd")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Error: 必要なツールがインストールされていません: ${missing[*]}" >&2
  echo "  Ubuntu/Debian: sudo apt install ${missing[*]}" >&2
  echo "  macOS:         brew install ${missing[*]}" >&2
  exit 1
fi

# ── クレデンシャル入力（対話的に読み取り、ps / history に残さない） ──
read -rp "API Key (Consumer Key): " API_KEY
if [[ -z "$API_KEY" ]]; then
  echo "Error: API Key が入力されませんでした" >&2
  exit 1
fi
read -rsp "API Secret (Consumer Secret): " API_SECRET
echo
if [[ -z "$API_SECRET" ]]; then
  echo "Error: API Secret が入力されませんでした" >&2
  exit 1
fi

CALLBACK="oob"  # PIN-based flow

# ── ヘルパー関数 ──

# RFC 3986 percent-encode (pure bash — curl / python 不要)
urlencode() {
  local string="$1"
  local length=${#string}
  local i c o
  for (( i = 0; i < length; i++ )); do
    c="${string:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) printf '%s' "$c" ;;
      *) o=$(printf '%02X' "'$c"); printf '%%%s' "$o" ;;
    esac
  done
}

# HMAC-SHA1 署名を生成
hmac_sha1() {
  local key="$1"
  local data="$2"
  printf '%s' "$data" | openssl dgst -sha1 -hmac "$key" -binary | openssl base64 -A
}

# OAuth 1.0a 署名を生成してヘッダーを返す
build_oauth_header() {
  local method="$1"
  local url="$2"
  local token="$3"
  local token_secret="$4"
  shift 4
  # 残りの引数は追加パラメータ (key=value)

  local nonce
  nonce=$(openssl rand -hex 16)
  local timestamp
  timestamp=$(date +%s)

  # OAuth パラメータ
  local -a params=(
    "oauth_consumer_key=$(urlencode "$API_KEY")"
    "oauth_nonce=$(urlencode "$nonce")"
    "oauth_signature_method=HMAC-SHA1"
    "oauth_timestamp=$timestamp"
    "oauth_version=1.0"
  )

  if [[ -n "$token" ]]; then
    params+=("oauth_token=$(urlencode "$token")")
  fi

  if [[ -n "$CALLBACK" && "$url" == *"request_token"* ]]; then
    params+=("oauth_callback=$(urlencode "$CALLBACK")")
  fi

  # 追加パラメータ
  for param in "$@"; do
    params+=("$param")
  done

  # ソートしてパラメータ文字列を構築（RFC 5849: byte-value order）
  local param_string
  param_string=$(printf '%s\n' "${params[@]}" | LC_ALL=C sort | paste -sd '&' -)

  # 署名ベース文字列
  local base_string="${method}&$(urlencode "$url")&$(urlencode "$param_string")"

  # 署名キー
  local signing_key="$(urlencode "$API_SECRET")&$(urlencode "$token_secret")"

  # 署名
  local signature
  signature=$(hmac_sha1 "$signing_key" "$base_string")

  # Authorization ヘッダー構築
  local header="OAuth "
  header+="oauth_consumer_key=\"$(urlencode "$API_KEY")\", "
  if [[ -n "$CALLBACK" && "$url" == *"request_token"* ]]; then
    header+="oauth_callback=\"$(urlencode "$CALLBACK")\", "
  fi
  header+="oauth_nonce=\"$(urlencode "$nonce")\", "
  header+="oauth_signature=\"$(urlencode "$signature")\", "
  header+="oauth_signature_method=\"HMAC-SHA1\", "
  header+="oauth_timestamp=\"$timestamp\", "
  if [[ -n "$token" ]]; then
    header+="oauth_token=\"$(urlencode "$token")\", "
  fi
  header+="oauth_version=\"1.0\""

  printf '%s' "$header"
}

# レスポンスからパラメータ値を取得（値に = が含まれていても安全）
parse_response_value() {
  local response="$1"
  local key="$2"
  echo "$response" | tr '&' '\n' | grep "^${key}=" | head -1 | cut -d= -f2-
}

# ── Step 1: Request Token 取得 ──

echo "=== Step 1: Request Token を取得中... ==="

REQUEST_TOKEN_URL="https://api.twitter.com/oauth/request_token"
auth_header=$(build_oauth_header "POST" "$REQUEST_TOKEN_URL" "" "")

http_code=$(curl -s -o /tmp/x-oauth-response -w '%{http_code}' \
  --proto =https -X POST "$REQUEST_TOKEN_URL" \
  -H "Authorization: $auth_header")
response=$(cat /tmp/x-oauth-response)
rm -f /tmp/x-oauth-response

if [[ "$http_code" != "200" ]]; then
  echo "Error: Request Token の取得に失敗しました (HTTP $http_code)" >&2
  echo "Response: $response" >&2
  exit 1
fi

if [[ "$response" != *"oauth_token="* ]]; then
  echo "Error: Request Token の取得に失敗しました（レスポンスに oauth_token がありません）" >&2
  echo "Response: $response" >&2
  exit 1
fi

oauth_token=$(parse_response_value "$response" "oauth_token")
oauth_token_secret=$(parse_response_value "$response" "oauth_token_secret")
echo "Request Token 取得成功"

# ── Step 2: ユーザー認可 ──

echo ""
echo "=== Step 2: 以下の URL をブラウザで開いて認可してください ==="
echo ""
echo "  https://api.twitter.com/oauth/authorize?oauth_token=${oauth_token}"
echo ""
read -rp "認可後に表示される PIN を入力してください: " pin

if [[ -z "$pin" || ! "$pin" =~ ^[0-9]+$ ]]; then
  echo "Error: PIN は数字で入力してください" >&2
  exit 1
fi

# ── Step 3: Access Token 取得 ──

echo ""
echo "=== Step 3: Access Token を取得中... ==="

ACCESS_TOKEN_URL="https://api.twitter.com/oauth/access_token"
auth_header=$(build_oauth_header "POST" "$ACCESS_TOKEN_URL" "$oauth_token" "$oauth_token_secret" \
  "oauth_verifier=$(urlencode "$pin")")

http_code=$(curl -s -o /tmp/x-oauth-response -w '%{http_code}' \
  --proto =https -X POST "$ACCESS_TOKEN_URL" \
  -H "Authorization: $auth_header" \
  -d "oauth_verifier=${pin}")
response=$(cat /tmp/x-oauth-response)
rm -f /tmp/x-oauth-response

if [[ "$http_code" != "200" ]]; then
  echo "Error: Access Token の取得に失敗しました (HTTP $http_code)" >&2
  echo "Response: $response" >&2
  exit 1
fi

if [[ "$response" != *"oauth_token="* ]]; then
  echo "Error: Access Token の取得に失敗しました（レスポンスに oauth_token がありません）" >&2
  echo "Response: $response" >&2
  exit 1
fi

access_token=$(parse_response_value "$response" "oauth_token")
access_token_secret=$(parse_response_value "$response" "oauth_token_secret")
screen_name=$(parse_response_value "$response" "screen_name")
user_id=$(parse_response_value "$response" "user_id")

echo ""
echo "=== 認可完了 ==="
echo "Screen Name : @${screen_name}"
echo "User ID     : ${user_id}"
echo ""
echo "以下を .env に設定してください:"
echo ""
echo "  SNS_PROVIDER=x"
echo "  SNS_ACCESS_TOKEN=${access_token}"
echo "  SNS_API_KEY=${API_KEY}"
echo "  SNS_API_SECRET=${API_SECRET}"
echo "  SNS_ACCESS_TOKEN_SECRET=${access_token_secret}"
