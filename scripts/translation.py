import json
from pathlib import Path
import requests
import os
import argparse
import signal
import sys

REPLACE_TARGET_KEYS = ['title', 'label', "contents", 'displayName', 'description', 'markdownDescription']
REPLACE_ENUM_DESCRIPTIONS = True

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
TARGET_LANGUAGE = "Chinese"
API_TEMPERATURE = 0.3

DICTIONARY_FILE = "translation_dictionary.json"
PROGRESS_FILE = "translation_progress.json"

GITHUB_ACTIONS = os.environ.get('GITHUB_ACTIONS', 'false').lower() == 'true'
VERBOSE = os.environ.get('VERBOSE', 'false').lower() == 'true'

PACKAGE_JSON_PATH = "package.json"
CONTRIBUTIONS_JSON_PATH = "contributions.json"


def log(msg: str):
    if GITHUB_ACTIONS:
        print(f"::info::{msg}")
    elif VERBOSE or not GITHUB_ACTIONS:
        print(msg)


def log_error(msg: str):
    if GITHUB_ACTIONS:
        print(f"::error::{msg}")
    else:
        print(f"错误: {msg}")


def log_warning(msg: str):
    if GITHUB_ACTIONS:
        print(f"::warning::{msg}")
    else:
        print(f"警告: {msg}")


def get_api_key():
    parser = argparse.ArgumentParser(description='翻译 package.json')
    parser.add_argument('--api-key', '-k', type=str, help='DeepSeek API Key')
    parser.add_argument('--key', '-K', type=str, dest='env_key', help='从环境变量读取 API Key')
    args = parser.parse_args()

    if args.api_key:
        return args.api_key
    if args.env_key:
        return os.environ.get(args.env_key, os.environ.get('DEEPSEEK_API_KEY', ''))
    return os.environ.get('DEEPSEEK_API_KEY', '')


class TranslationDictionary:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self.dictionary = {}
        self.load()

    def load(self):
        if self.file_path.exists():
            with open(self.file_path, 'r', encoding='utf-8') as f:
                self.dictionary = json.load(f)
            log(f"词典已加载: {len(self.dictionary)} 条记录")

    def save(self):
        with open(self.file_path, 'w', encoding='utf-8') as f:
            json.dump(self.dictionary, f, ensure_ascii=False, indent=2)

    def get(self, text: str) -> str:
        return self.dictionary.get(text)

    def set(self, text: str, translated: str):
        self.dictionary[text] = translated
        self.save()

    def exists(self, text: str) -> bool:
        return text in self.dictionary


class ProgressBar:
    def __init__(self, total: int, width: int = 50, desc: str = ""):
        self.total = total
        self.width = width
        self.desc = desc
        self.current = 0
        self.api_calls = 0
        self.cache_hits = 0

    def update(self, n: int = 1, api_call: bool = False, cache_hit: bool = False):
        self.current += n
        if api_call:
            self.api_calls += 1
        if cache_hit:
            self.cache_hits += 1
        self.draw()

    def draw(self):
        percent = self.current / self.total if self.total > 0 else 1.0
        filled = int(self.width * percent)
        bar = "█" * filled + "░" * (self.width - filled)

        status = f"[{bar}] {self.current}/{self.total}"
        status += f" | API: {self.api_calls} | 缓存: {self.cache_hits}"
        if not GITHUB_ACTIONS:
            print(f"\r{self.desc} {status}", end="", flush=True)

    def finish(self):
        if not GITHUB_ACTIONS:
            print()


def translate_text(text: str, dictionary: TranslationDictionary, progress: ProgressBar, api_key: str) -> str:
    if not text or not text.strip():
        return text

    if dictionary.exists(text):
        progress.update(1, cache_hit=True)
        return dictionary.get(text)

    progress.update(1, api_call=True)

    url = f"{DEEPSEEK_BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "deepseek-chat",
        "messages": [
            {
                "role": "system",
                "content": f"""Translate the following text to {TARGET_LANGUAGE}. Keep the meaning accurate but natural. Only return the translated text, nothing else.

IMPORTANT RULES:
1. Do NOT translate any code syntax, including: variable placeholders like ${{path}}, ${{variable}}, ${{file}}, etc.
2. Do NOT translate content inside brackets, parentheses, braces, quotes, or any code delimiters.
3. Do NOT translate file paths, URLs, or technical identifiers.
4. Only translate the human-readable description text outside of code syntax.
5. Preserve all punctuation and special characters exactly as they are."""
            },
            {
                "role": "user",
                "content": text
            }
        ],
        "temperature": API_TEMPERATURE,
        "max_tokens": 2000
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=60)
        response.raise_for_status()
        result = response.json()
        translated = result["choices"][0]["message"]["content"].strip()
        dictionary.set(text, translated)
        return translated
    except KeyboardInterrupt:
        print(f"\n\n检测到用户中断，正在保存词典...")
        dictionary.save()
        print(f"词典已保存到 {DICTIONARY_FILE}")
        sys.exit(0)
    except requests.exceptions.Timeout:
        log_error(f"API 请求超时: {text[:50]}...")
        return text
    except requests.exceptions.RequestException as e:
        log_error(f"API 请求失败: {e}")
        return text
    except json.JSONDecodeError as e:
        log_error(f"API 响应解析失败: {e}")
        return text
    except Exception as e:
        log_error(f"翻译失败: {e}")
        return text


def count_translatable_items(obj) -> int:
    count = 0
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in REPLACE_TARGET_KEYS and isinstance(value, str):
                count += 1
            elif key == 'enumDescriptions' and isinstance(value, list):
                count += sum(1 for item in value if isinstance(item, str))
            else:
                count += count_translatable_items(value)
    elif isinstance(obj, list):
        for item in obj:
            count += count_translatable_items(item)
    return count


def traverse_and_translate(obj, dictionary: TranslationDictionary, progress: ProgressBar, api_key: str, path=""):
    if isinstance(obj, dict):
        for key, value in obj.items():
            current_path = f"{path}.{key}" if path else key
            if key in REPLACE_TARGET_KEYS and isinstance(value, str):
                obj[key] = translate_text(value, dictionary, progress, api_key)
            elif key == 'enumDescriptions' and isinstance(value, list):
                for i, item in enumerate(value):
                    if isinstance(item, str):
                        value[i] = translate_text(item, dictionary, progress, api_key)
            else:
                traverse_and_translate(value, dictionary, progress, api_key, current_path)
    elif isinstance(obj, list):
        for index, item in enumerate(obj):
            current_path = f"{path}[{index}]"
            traverse_and_translate(item, dictionary, progress, api_key, current_path)


def count_contributions_translatable_items(obj) -> int:
    count = 0
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == 'label' and isinstance(value, str):
                count += 1
            elif key == 'name' and isinstance(value, str):
                count += 1
            elif key == 'contents' and isinstance(value, str):
                count += 1
            elif key in ['title', 'description']:
                count += count_contributions_translatable_items(value)
            else:
                count += count_contributions_translatable_items(value)
    elif isinstance(obj, list):
        for item in obj:
            count += count_contributions_translatable_items(item)
    return count


def translate_contributions_file(file_path: str, dictionary: TranslationDictionary, api_key: str) -> bool:
    path = Path(file_path)
    if not path.exists():
        log_warning(f"文件不存在: {file_path}")
        return False

    with open(file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    log(f"正在翻译: {file_path}")

    total_items = count_contributions_translatable_items(data)
    if total_items == 0:
        log(f"  没有需要翻译的内容")
        return True

    already_translated = sum(1 for k in dictionary.dictionary.keys() if isinstance(k, str))
    remaining = total_items - already_translated
    log(f"  可翻译项: {total_items} | 需翻译: {remaining}")

    progress = ProgressBar(total_items, desc=f"翻译 {path.name}:")

    def translate_in_object(obj, current_path=""):
        if isinstance(obj, dict):
            for key, value in obj.items():
                if key == 'label' and isinstance(value, str):
                    obj[key] = translate_text(value, dictionary, progress, api_key)
                elif key == 'name' and isinstance(value, str):
                    obj[key] = translate_text(value, dictionary, progress, api_key)
                elif key == 'contents' and isinstance(value, str):
                    obj[key] = translate_text(value, dictionary, progress, api_key)
                elif key in ['title', 'description'] and isinstance(value, str):
                    obj[key] = translate_text(value, dictionary, progress, api_key)
                else:
                    translate_in_object(value, f"{current_path}.{key}" if current_path else key)
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                translate_in_object(item, f"{current_path}[{i}]")

    translate_in_object(data)
    progress.finish()

    log(f"  完成! API调用: {progress.api_calls} | 缓存: {progress.cache_hits}")

    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

    return True


def signal_handler(signum, frame):
    log_warning("检测到中断信号，正在保存词典...")
    dictionary.save()
    log(f"词典已保存到 {DICTIONARY_FILE}")
    log("程序已退出")
    sys.exit(0)


def main():
    global dictionary

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    file_path = Path(PACKAGE_JSON_PATH)
    dictionary = TranslationDictionary(DICTIONARY_FILE)

    api_key = get_api_key()
    if not api_key:
        log_error("未提供 API Key")
        log("使用方法:")
        log("  python3 demo.py                                      # 使用环境变量 DEEPSEEK_API_KEY")
        log("  python3 demo.py --api-key YOUR_KEY                   # 直接传入 API Key")
        log("  python3 demo.py --key CUSTOM_ENV_VAR                 # 使用指定环境变量")
        sys.exit(1)

    if not file_path.exists():
        log_error(f"文件不存在: {file_path}")
        sys.exit(1)

    with open(file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    log(f"目标语言: {TARGET_LANGUAGE}")
    log(f"温度参数: {API_TEMPERATURE}")

    total_items = count_translatable_items(data)
    log(f"可翻译项: {total_items}")

    already_translated = sum(1 for k in dictionary.dictionary.keys() if isinstance(k, str))
    remaining = total_items - already_translated
    log(f"词典已有: {already_translated} 条")
    log(f"需翻译项: {remaining} 条")

    if remaining <= 0:
        log("所有项已在词典中，跳过翻译")
        traverse_and_translate(data, dictionary, ProgressBar(total_items, desc="应用词典:"), api_key)
    else:
        if not GITHUB_ACTIONS:
            log(f"开始翻译... (按 Ctrl+C 可随时中断，词典会自动保存)")
        progress = ProgressBar(total_items, desc="翻译进度:")
        traverse_and_translate(data, dictionary, progress, api_key)
        progress.finish()

    log(f"翻译完成! API调用: {progress.api_calls} | 缓存命中: {progress.cache_hits}")

    with open(PACKAGE_JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    log(f"已保存到 {PACKAGE_JSON_PATH}")

    log("")
    log("=" * 50)
    log("开始翻译 contributions.json...")
    log("=" * 50)
    log("")

    translate_contributions_file(CONTRIBUTIONS_JSON_PATH, dictionary, api_key)

    dictionary.save()
    log(f"词典已保存到 {DICTIONARY_FILE}")


if __name__ == "__main__":
    main()
