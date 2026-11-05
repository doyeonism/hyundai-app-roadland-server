#!/usr/bin/env python3
"""
운영 .env 를 새 주소 변수 규칙에 맞게 패치하고, GitHub Actions 시크릿(ENV_FILES 등)으로 올린다.

  규칙 (envs/.env.example 참고)
    API_BASE_URL   = http://<PROJECT_NAME>-server:<SERVER_PORT>   컨테이너 내부에서 SSR/proxy 가 부르는 API
    API_PUBLIC_URL = https://<SERVER_NAME>                        브라우저에서 부르는 API (소셜 콜백 조립)
    WEB_PUBLIC_URL = https://<SERVER_NAME>                        web 앱 주소 (재설정 메일 링크·소셜 랜딩)
    NEXT_PUBLIC_API_BASE_URL = API_PUBLIC_URL                     (비어 있거나 localhost 면 채움)
    IMAGE_PREFIX   = ghcr.io/<owner>/<repo>                       (없으면 추가)
    제거: PUBLIC_API_URL, NEXT_PUBLIC_PROJECT_NAME (PROJECT_NAME 에서 자동 유도)

  사용
    # 1) 패치 결과만 확인 (파일은 건드리지 않음, 값은 변경된 키만 출력)
    python3 scripts/update-prod-env.py --file envs/.env.prod --repo owner/repo

    # 2) 파일에 반영
    python3 scripts/update-prod-env.py --file envs/.env.prod --repo owner/repo --write

    # 3) 파일을 ENV_FILES 시크릿으로 업로드 (+ PROJECT_NAME / NETWORK_NAME 시크릿도 같이)
    GH_TOKEN=ghp_xxx python3 scripts/update-prod-env.py --file envs/.env.prod --repo owner/repo --write --upload

  업로드에는 `gh` CLI(있으면 사용) 또는 `pip install pynacl` 이 필요하다.
  토큰은 GH_TOKEN 환경변수로 넘긴다 (classic PAT 의 `repo` 스코프, 또는 fine-grained 의 Secrets: write).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

LINE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def parse(text: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw in text.splitlines():
        m = LINE.match(raw.strip())
        if m:
            env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return env


def set_key(lines: list[str], key: str, value: str) -> bool:
    """키가 있으면 마지막 정의를 교체, 없으면 끝에 추가. 바뀐 경우 True."""
    idx = [i for i, l in enumerate(lines) if LINE.match(l.strip()) and LINE.match(l.strip()).group(1) == key]
    new = f"{key}={value}"
    if idx:
        if lines[idx[-1]].strip() == new:
            return False
        lines[idx[-1]] = new
        return True
    lines.append(new)
    return True


def drop_key(lines: list[str], key: str) -> bool:
    before = len(lines)
    lines[:] = [l for l in lines if not (LINE.match(l.strip()) and LINE.match(l.strip()).group(1) == key)]
    return len(lines) != before


def patch(text: str, repo: str | None) -> tuple[str, list[str], list[str]]:
    env = parse(text)
    lines = text.rstrip("\n").split("\n")
    changed: list[str] = []
    warnings: list[str] = []

    project = env.get("PROJECT_NAME")
    server_port = env.get("SERVER_PORT", "3000")
    server_name = env.get("SERVER_NAME")
    if not project:
        warnings.append("PROJECT_NAME 이 없어 API_BASE_URL 을 만들 수 없습니다.")
    if not server_name:
        warnings.append("SERVER_NAME 이 없어 API_PUBLIC_URL / WEB_PUBLIC_URL 을 만들 수 없습니다.")

    if project and set_key(lines, "API_BASE_URL", f"http://{project}-server:{server_port}"):
        changed.append("API_BASE_URL")
    if server_name:
        public = f"https://{server_name}"
        if set_key(lines, "API_PUBLIC_URL", public):
            changed.append("API_PUBLIC_URL")
        if set_key(lines, "WEB_PUBLIC_URL", public):
            changed.append("WEB_PUBLIC_URL")
        current_browser = env.get("NEXT_PUBLIC_API_BASE_URL", "")
        if not current_browser or "localhost" in current_browser or "127.0.0.1" in current_browser:
            if set_key(lines, "NEXT_PUBLIC_API_BASE_URL", public):
                changed.append("NEXT_PUBLIC_API_BASE_URL")
    if repo and "IMAGE_PREFIX" not in env and set_key(lines, "IMAGE_PREFIX", f"ghcr.io/{repo.lower()}"):
        changed.append("IMAGE_PREFIX")
    for key in ("PUBLIC_API_URL", "NEXT_PUBLIC_PROJECT_NAME"):
        if drop_key(lines, key):
            changed.append(f"-{key}")

    cookie = env.get("COOKIE_DOMAIN", "")
    if server_name and cookie and not server_name.endswith(cookie.lstrip(".")):
        warnings.append(f"COOKIE_DOMAIN({cookie}) 이 SERVER_NAME({server_name}) 과 맞지 않습니다.")
    for key in ("ACCESS_JWT_SECRET", "REFRESH_JWT_SECRET", "SIGN_UP_JWT_SECRET", "POSTGRES_PASSWORD", "ADMIN_PASSWORD"):
        if env.get(key, "").startswith(("replace-with", "change-me")):
            warnings.append(f"{key} 가 예시 값 그대로입니다.")
    return "\n".join(lines) + "\n", changed, warnings


# ── GitHub 시크릿 업로드 ────────────────────────────────────────────────────

def gh_api(token: str, method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as res:
        raw = res.read()
        return json.loads(raw) if raw else {}


def seal(public_key_b64: str, value: str) -> str:
    from nacl import encoding, public  # pip install pynacl

    pk = public.PublicKey(public_key_b64.encode(), encoding.Base64Encoder())
    return base64.b64encode(public.SealedBox(pk).encrypt(value.encode())).decode()


def upload(repo: str, token: str, secrets: dict[str, str]) -> None:
    if shutil.which("gh"):
        for name, value in secrets.items():
            subprocess.run(["gh", "secret", "set", name, "--repo", repo], input=value.encode(), check=True)
            print(f"  ✔ {name} (gh)")
        return
    key = gh_api(token, "GET", f"/repos/{repo}/actions/secrets/public-key")
    for name, value in secrets.items():
        gh_api(token, "PUT", f"/repos/{repo}/actions/secrets/{name}",
               {"encrypted_value": seal(key["key"], value), "key_id": key["key_id"]})
        print(f"  ✔ {name} (api)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", required=True, help="운영 .env 파일 경로 (예: envs/.env.prod)")
    ap.add_argument("--repo", help="owner/repo — IMAGE_PREFIX 기본값과 시크릿 업로드 대상")
    ap.add_argument("--write", action="store_true", help="패치 결과를 파일에 저장")
    ap.add_argument("--upload", action="store_true", help="ENV_FILES / PROJECT_NAME / NETWORK_NAME 시크릿 업로드 (--write 필요)")
    args = ap.parse_args()

    text = open(args.file, encoding="utf-8").read()
    patched, changed, warnings = patch(text, args.repo)
    env = parse(patched)

    print(f"파일: {args.file}")
    print("변경:", ", ".join(changed) if changed else "(없음)")
    for key in ("PROJECT_NAME", "SERVER_NAME", "API_BASE_URL", "API_PUBLIC_URL", "WEB_PUBLIC_URL", "NEXT_PUBLIC_API_BASE_URL", "IMAGE_PREFIX", "COOKIE_DOMAIN"):
        print(f"  {key:26}= {env.get(key, '(없음)')}")
    for w in warnings:
        print(f"⚠️  {w}")

    if args.write:
        open(args.file, "w", encoding="utf-8").write(patched)
        print("✔ 파일에 반영했습니다.")
    elif changed:
        print("(드라이런 — --write 로 저장)")

    if args.upload:
        if not args.write:
            print("❌ --upload 는 --write 와 함께 써야 합니다 (올리는 내용 = 파일 내용).")
            return 1
        if not args.repo:
            print("❌ --upload 에는 --repo owner/repo 가 필요합니다.")
            return 1
        token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        if not token and not shutil.which("gh"):
            print("❌ GH_TOKEN 환경변수 또는 gh CLI 가 필요합니다.")
            return 1
        secrets = {"ENV_FILES": patched, "PROJECT_NAME": env.get("PROJECT_NAME", ""), "NETWORK_NAME": env.get("NETWORK_NAME", "")}
        print(f"업로드 → {args.repo}: {', '.join(secrets)}")
        upload(args.repo, token or "", secrets)
        print("✔ 완료. VM 접속용 VM_HOST / VM_USER / VM_PORT / VM_SSH_KEY 는 별도로 등록하세요.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
