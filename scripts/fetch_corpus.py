#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
主数据归并检索系统 · 数据获取层（ChaosForge Phase 4 / Task 20）。

职责：以「脚本化、可重跑、断网降级」的方式准备测试数据层，产出三份真实 fixtures：
  - tests/fixtures/corpus/master-data.json  （已有主数据，>=300 条）
  - tests/fixtures/corpus/candidates.json   （5 类干扰候选，每类 >=30 条，合计 >=150 条）
  - tests/fixtures/corpus/MANIFEST.json     （来源、生成方式、条数、字段校验、5 类分布、降级原因）

三级降级（每级失败均显式 print 降级原因，绝不静默）：
  层级 1：解析仓库可见的 domain/corpus/dictionary/ 下官方公开药品目录（医保发〔2024〕33 号）文件副本；
  层级 2：联网下载官方公开文件（urllib，单次超时 <=5s，失败显式报错）；
  层级 3：仍不可得时用配置化确定性仿真器产出同 schema 语料，标 source=synthetic-simulator 并写明降级原因。

幂等性：
  - 固定随机种子 DETERMINISTIC_SEED；通用名 × 规格模板做笛卡尔组合后由固定种子打乱并截取；
  - 不使用系统当前时间等易变输入：所有 submitted_at / generated_at 基于固定基准时间；
  - 输出按 record_id / candidate_id 稳定排序，JSON 固定缩进与字段插入顺序；
  - 同输入连跑两次，三份文件内容字节级一致（含 MANIFEST 内的文件 sha256）。

依赖：Python 3.13 标准库（json / random / hashlib / urllib / pathlib / datetime）。
注意：层级 1/2 命中时，官方文本只作为「通用名词表」输入，最终记录仍由同一确定性仿真器
构造，以保证 schema、规模门槛与可复现性一致；本轮环境该目录不可达、联网不可得，稳定走层级 3。
"""
from __future__ import annotations

import hashlib
import json
import random
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# 确定性配置（改这些常量即改语料，重跑可复现）
# ---------------------------------------------------------------------------
DETERMINISTIC_SEED = 20240433
DOWNLOAD_TIMEOUT_SECONDS = 5
SOURCE_TAG = "synthetic-simulator"
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
FIXTURE_DIR = PROJECT_ROOT / "tests" / "fixtures" / "corpus"

# 固定基准时间：不使用当前时间，保证 MANIFEST 与 submitted_at 重跑一致。
SIMULATED_BASE_TIME = datetime(2024, 7, 1, 8, 0, 0, tzinfo=timezone(timedelta(hours=8)))

# 规模门槛（高于验收下限，留缓冲）
DRUG_MASTER_TARGET = 300          # drug 域主数据条数
NON_DRUG_MASTER_TARGET = 20       # fee_item / department / exam 主数据条数
CANDIDATES_PER_CATEGORY = 32      # 5 类各 32 条，合计 160 条（验收每类 >=30、合计 >=150）

# ---------------------------------------------------------------------------
# 真实中国药典 / 临床常见通用名（不含剂型），>=60 个，做笛卡尔组合，不用随机乱码
# ---------------------------------------------------------------------------
GENERIC_NAMES: list[str] = [
    "阿莫西林", "布洛芬", "头孢克肟", "阿奇霉素", "头孢氨苄", "阿托伐他汀",
    "氨氯地平", "缬沙坦", "氯沙坦", "厄贝沙坦", "二甲双胍", "阿卡波糖",
    "奥美拉唑", "兰索拉唑", "艾司奥美拉唑", "多潘立酮", "莫沙必利", "蒙脱石",
    "双歧杆菌", "左氧氟沙星", "莫西沙星", "克拉霉素", "罗红霉素", "头孢呋辛",
    "头孢曲松", "头孢他啶", "甲硝唑", "替硝唑", "奥硝唑", "阿昔洛韦",
    "伐昔洛韦", "奥司他韦", "氟康唑", "伊曲康唑", "对乙酰氨基酚", "双氯芬酸",
    "塞来昔布", "依托考昔", "美洛昔康", "氯吡格雷", "华法林", "利伐沙班",
    "瑞舒伐他汀", "辛伐他汀", "美托洛尔", "比索洛尔", "呋塞米", "螺内酯",
    "氨溴索", "乙酰半胱氨酸", "右美沙芬", "沙丁胺醇", "氨茶碱", "孟鲁司特",
    "布地奈德", "氟替卡松", "泼尼松", "地塞米松", "甲泼尼龙", "格列齐特",
    "格列美脲", "西格列汀", "达格列净", "恩格列净", "左甲状腺素", "甲巯咪唑",
    "雷贝拉唑", "泮托拉唑", "法莫替丁", "铝碳酸镁", "枸橼酸铋钾", "乳果糖",
]

# 通用名 -> 真实商品名 / 临床别名（用于「同义改名」类候选，覆盖前 41 个通用名）
BRAND_NAMES: dict[str, str] = {
    "阿莫西林": "再林", "布洛芬": "芬必得", "头孢克肟": "世福素", "阿奇霉素": "希舒美",
    "头孢氨苄": "先锋四号", "阿托伐他汀": "立普妥", "氨氯地平": "络活喜", "缬沙坦": "代文",
    "氯沙坦": "科素亚", "厄贝沙坦": "安博维", "二甲双胍": "格华止", "阿卡波糖": "拜唐苹",
    "奥美拉唑": "洛赛克", "兰索拉唑": "达克普隆", "艾司奥美拉唑": "耐信", "多潘立酮": "吗丁啉",
    "莫沙必利": "加斯清", "蒙脱石": "思密达", "双歧杆菌": "培菲康", "左氧氟沙星": "可乐必妥",
    "莫西沙星": "拜复乐", "克拉霉素": "克拉仙", "罗红霉素": "严迪", "头孢呋辛": "西力欣",
    "头孢曲松": "罗氏芬", "头孢他啶": "复达欣", "甲硝唑": "弗莱格", "替硝唑": "希普宁",
    "奥硝唑": "圣诺安", "阿昔洛韦": "无环鸟苷", "伐昔洛韦": "明竹欣", "奥司他韦": "达菲",
    "氟康唑": "大扶康", "伊曲康唑": "斯皮仁诺", "对乙酰氨基酚": "扑热息痛", "双氯芬酸": "扶他林",
    "塞来昔布": "西乐葆", "依托考昔": "安康信", "美洛昔康": "莫比可", "氯吡格雷": "波立维",
    "华法林": "可密定",
}

# (含量数值, 含量单位, 包装数, 包装单位, 剂型, 计价单位)；最后一条为体积型，不参与换单位候选
SPEC_TEMPLATES: list[tuple[float, str, int, str, str, str]] = [
    (0.25, "g", 12, "片", "片剂", "盒"),
    (0.5, "g", 24, "片", "片剂", "盒"),
    (10, "mg", 7, "片", "片剂", "盒"),
    (20, "mg", 14, "粒", "胶囊剂", "盒"),
    (0.1, "g", 12, "粒", "胶囊剂", "盒"),
    (50, "mg", 10, "袋", "颗粒剂", "盒"),
    (100, "ml", 1, "瓶", "口服溶液剂", "瓶"),
    (0.2, "g", 6, "支", "注射剂", "盒"),
]

# 非药域（用于 domain 合法值覆盖与检索分流对照）
NON_DRUG_NAMES: dict[str, tuple[list[str], str, str, str, str, str]] = {
    "fee_item": (["挂号费", "诊查费", "床位费", "护理费", "治疗费", "检查费",
                  "检验费", "药事服务费", "门诊输液费", "手术费", "麻醉费", "输血费"],
                 "FY", "XJ5000000000000", "1次", "诊疗服务", "次"),
    "department": (["心血管内科", "呼吸与危重症医学科", "消化内科", "神经内科"],
                   "KS", "XJ4000000000000", "1科室", "科室", "科"),
    "exam": (["血常规", "尿常规", "肝功能", "肾功能"],
             "JC", "XJ3000000000000", "1项", "检验检查", "项"),
}

# 5 类候选的元信息：类别标签 / id 段 / 期望方向 / 提交来源 / 口径说明
CATEGORY_META: dict[str, dict[str, str]] = {
    "同义改名": {
        "code": "ALIAS", "expect": "merge", "submit_source": "药械科名称维护",
        "detail": "商品名或别名映射通用名，携带目标医保码唯一命中，应并入对照记录",
    },
    "同名异规格": {
        "code": "SPECDIFF", "expect": "non-merge", "submit_source": "院内 HIS 导出",
        "detail": "名称与对照记录相同但规格不同且无对应主数据，绝不能并，应转存疑或新建",
    },
    "换单位": {
        "code": "UNITCONV", "expect": "merge", "submit_source": "医保目录同步",
        "detail": "规格含量单位换算后归一相等，应并入对照记录",
    },
    "停用码": {
        "code": "INACTIVE", "expect": "uncertain", "submit_source": "历史码表清理",
        "detail": "唯一命中目标主数据状态为停用，不得自动并入，应转存疑",
    },
    "医保码错配": {
        "code": "CODEMIS", "expect": "non-merge", "submit_source": "手工录入补录",
        "detail": "名称规格与对照相同但医保码全局无匹配，不得仅凭名称相同就合并",
    },
}
CATEGORY_ORDER: list[str] = list(CATEGORY_META.keys())

# 官方公开文件候选相对路径（相对脚本所在目录 scripts/）。
# 层级 1 只接受本任务可见范围内的文件副本；若存在亦仅用于补充通用名词表。
LOCAL_CATALOG_RELPATHS: list[str] = [
    "../../../domain/corpus/dictionary/drug_catalog_2024_国家基本医疗保险工伤保险和生育保险药品目录2024年通知全文.txt",
    "../../domain/corpus/dictionary/drug_catalog_2024_国家基本医疗保险工伤保险和生育保险药品目录2024年通知全文.txt",
]
# 层级 2 的官方公开来源入口（真实国家医保局官网域名）。精确文件地址可由部署环境通过
# DRUG_CATALOG_URL 环境变量覆盖；默认仅探测入口，若拿不到结构化药品表则继续降级。
DEFAULT_DOWNLOAD_URLS: list[str] = ["https://www.nhsa.gov.cn/"]
# MANIFEST 里的层级 2 原因用稳定表述，避免网络波动改变文件字节；逐源真实结果仍由 stdout 显式打印。
TIER2_MANIFEST_REASON = (
    "降级 2：尝试联网下载官方公开文件（urllib，单次超时上限 5s）后仍未取得足量结构化药品通用名"
    "（采用阈值 60），逐源下载结果与失败原因见脚本 stdout"
)

DOSAGE_SUFFIXES = ("缓释片", "控释片", "肠溶片", "胶囊剂", "颗粒剂", "注射剂",
                   "口服溶液", "干混悬剂", "散剂", "片", "胶囊", "颗粒", "丸", "注射液")


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def log(message: str) -> None:
    """显式输出降级与生成过程，禁止静默。"""
    print(f"[fetch_corpus] {message}", flush=True)


def fmt_num(value: float) -> str:
    """把含量数值格式化为干净字符串：0.25 -> 0.25，10 -> 10，0.01 -> 0.01。"""
    return f"{value:g}"


def convert_strength(value: float, unit: str) -> tuple[float, str]:
    """质量单位跨级换算（g <-> mg），仅用于「换单位」候选；其它维度原样返回。"""
    if unit == "g":
        return value * 1000, "mg"
    if unit == "mg":
        return value / 1000, "g"
    return value, unit


def to_json_text(obj: Any) -> str:
    """固定序列化口径，保证重跑字节一致。"""
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# 层级 1：本地官方公开药品目录文件
# ---------------------------------------------------------------------------
def resolve_local_catalog() -> tuple[Path | None, str | None, list[str]]:
    """返回 (首个存在的路径, 文本, 尝试记录列表)。逐条打印，不静默。"""
    attempts: list[str] = []
    for rel in LOCAL_CATALOG_RELPATHS:
        candidate = SCRIPT_DIR / rel
        resolved = candidate.resolve()
        exists = candidate.is_file()
        attempts.append(f"{rel} -> {'存在' if exists else '不存在'}")
        log(f"层级 1 探测本地官方目录：{rel}（{'存在' if exists else '不存在'}，解析为 {resolved}）")
        if exists:
            return candidate, candidate.read_text(encoding="utf-8", errors="replace"), attempts
    return None, None, attempts


# ---------------------------------------------------------------------------
# 层级 2：联网下载官方公开文件
# ---------------------------------------------------------------------------
def try_download() -> tuple[str | None, str | None, str | None]:
    """返回 (成功 url, 文本, 失败原因聚合)。单次超时 <=5s；任何失败显式记录原因。"""
    urls = list(DEFAULT_DOWNLOAD_URLS)
    failures: list[str] = []
    log(f"层级 2 尝试联网下载官方公开文件（单次超时上限 {DOWNLOAD_TIMEOUT_SECONDS}s）...")
    for url in urls:
        if not url:
            continue
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "master-data-merge-search/phase4"})
            with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
                raw = response.read(2 * 1024 * 1024)
            text = raw.decode("utf-8", errors="replace")
            log(f"层级 2 下载成功：{url}（{len(text)} 字符）")
            return url, text, None
        except Exception as exc:  # urllib.error.URLError / TimeoutError / OSError 等
            reason = f"{url} -> {type(exc).__name__}: {exc}"
            failures.append(reason)
            log(f"降级 2：下载 {url} 失败（{type(exc).__name__}），继续尝试其它来源；原因：{exc}")
    return None, None, "；".join(failures) if failures else "未配置可下载来源"


# ---------------------------------------------------------------------------
# 官方文本解析：只做「通用名词表」抽取，词表交由层级 3 仿真器确定性构造
# ---------------------------------------------------------------------------
def parse_official_text(text: str) -> list[str]:
    """从官方目录文本中抽取以常见剂型后缀结尾的药品通用名，去重后排序。"""
    found: set[str] = set()
    for raw_line in text.splitlines():
        line = raw_line.strip().strip("　")
        if not (4 <= len(line) <= 40):
            continue
        for suffix in DOSAGE_SUFFIXES:
            pos = line.rfind(suffix)
            if pos < 2:
                continue
            name = line[: pos + len(suffix)].lstrip("0123456789、.· （）()甲乙类协议期类别")
            if 2 <= len(name) <= 20 and all(ch.isprintable() for ch in name):
                found.add(name)
            break
    return sorted(found)


# ---------------------------------------------------------------------------
# 层级 3：配置化确定性仿真器
# ---------------------------------------------------------------------------
def build_generic_names(extra_names: list[str]) -> tuple[list[str], list[str]]:
    """合并内置通用名与官方解析词表，去重排序后返回 (词表, 新增词表)。"""
    merged = set(GENERIC_NAMES)
    added = sorted(name for name in set(extra_names) if name not in merged)
    merged.update(added)
    return sorted(merged), added


def build_master_data(names: list[str]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """构造已有主数据：drug 域笛卡尔组合 + 非药域对照，含内部结构字段（导出时剔除）。"""
    rng = random.Random(DETERMINISTIC_SEED)
    combos = [(name_index, tpl_index)
              for name_index in range(len(names))
              for tpl_index in range(len(SPEC_TEMPLATES))]
    rng.shuffle(combos)
    selected = combos[:DRUG_MASTER_TARGET]

    records: list[dict[str, Any]] = []
    for i, (name_index, tpl_index) in enumerate(selected):
        name = names[name_index]
        value, unit, pack, pack_unit, form, price_unit = SPEC_TEMPLATES[tpl_index]
        records.append({
            "code": f"YP{600000 + i:06d}",
            "record_id": f"MD-{i + 1:06d}",
            "domain": "drug",
            "name": name,
            "spec": f"{fmt_num(value)}{unit}*{pack}{pack_unit}",
            "dosage_form": form,
            "unit": price_unit,
            "insurance_code": f"XJ{7000000000000 + i:013d}",
            "status": "停用" if i % 8 == 7 else "启用",
            "version": "v2" if i % 3 == 0 else "v1",
            "_strength_value": value,
            "_strength_unit": unit,
            "_pack_count": pack,
            "_pack_unit": pack_unit,
        })

    drug_count = len(records)
    global_i = drug_count
    for domain, (domain_names, code_prefix, code_base, spec, form, unit) in NON_DRUG_NAMES.items():
        for name in domain_names[:NON_DRUG_MASTER_TARGET]:
            i = global_i
            global_i += 1
            records.append({
                "code": f"{code_prefix}{600000 + i:06d}",
                "record_id": f"MD-{i + 1:06d}",
                "domain": domain,
                "name": name,
                "spec": spec,
                "dosage_form": form,
                "unit": unit,
                "insurance_code": f"XJ{int(code_base[2:]) + i:013d}",
                "status": "启用",
                "version": "v1",
            })

    records.sort(key=lambda r: r["record_id"])
    stats = {
        "drug_count": drug_count,
        "total_count": len(records),
        "inactive_drug_count": sum(1 for r in records[:drug_count] if r["status"] == "停用"),
        "enabled_drug_count": sum(1 for r in records[:drug_count] if r["status"] == "启用"),
    }
    return records, stats


def build_candidates(master: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """基于主数据确定性构造 5 类干扰候选，每条 source_note 带类别 / 对照记录 / 期望方向。"""
    drug = [r for r in master if r["domain"] == "drug"]
    enabled = [r for r in drug if r["status"] == "启用"]
    inactive = [r for r in drug if r["status"] == "停用"]
    all_specs = {r["spec"] for r in master}
    all_insurance_codes = {r["insurance_code"] for r in master}

    assert len(enabled) >= 4 * CANDIDATES_PER_CATEGORY, "启用 drug 主数据不足以覆盖 4 类对照"
    assert len(inactive) >= CANDIDATES_PER_CATEGORY, "停用 drug 主数据不足以覆盖停用码类"

    # 4 类启用对照 target 互不重叠
    alias_pool = [r for r in enabled[4 * CANDIDATES_PER_CATEGORY:] if r["name"] in BRAND_NAMES]
    assert len(alias_pool) >= CANDIDATES_PER_CATEGORY, "有真实商品名映射的通用名不足 32 条"
    targets: dict[str, list[dict[str, Any]]] = {
        "同义改名": alias_pool[:CANDIDATES_PER_CATEGORY],
        "同名异规格": enabled[0:CANDIDATES_PER_CATEGORY],
        "医保码错配": enabled[CANDIDATES_PER_CATEGORY:2 * CANDIDATES_PER_CATEGORY],
    }
    mass_enabled = [r for r in enabled[2 * CANDIDATES_PER_CATEGORY:]
                    if r["_strength_unit"] in ("g", "mg")]
    assert len(mass_enabled) >= CANDIDATES_PER_CATEGORY, "可换单位的质量型 target 不足 32 条"
    targets["换单位"] = mass_enabled[:CANDIDATES_PER_CATEGORY]
    targets["停用码"] = inactive[:CANDIDATES_PER_CATEGORY]

    # 用固定种子派生提交时间起始偏移，保证 submitted_at 确定且各类不重复
    rng = random.Random(DETERMINISTIC_SEED + 1)
    start_minutes = {category: rng.randint(0, 500) for category in CATEGORY_ORDER}

    candidates: list[dict[str, Any]] = []
    cand_index = 0
    for category in CATEGORY_ORDER:
        meta = CATEGORY_META[category]
        for k, target in enumerate(targets[category], start=1):
            name = target["name"]
            spec = target["spec"]
            insurance_code = target["insurance_code"]
            detail = meta["detail"]

            if category == "同义改名":
                name = BRAND_NAMES[target["name"]]
                detail = f"商品名「{name}」映射通用名「{target['name']}」，携带目标医保码唯一命中，应并入对照记录"
            elif category == "同名异规格":
                value = target["_strength_value"] * 3 + 0.13
                spec = f"{fmt_num(value)}{target['_strength_unit']}*{target['_pack_count'] + 7}{target['_pack_unit']}"
                insurance_code = f"XJ{9100000000000 + k:013d}"
                assert spec not in all_specs, f"同名异规格候选规格意外撞主数据：{spec}"
                assert insurance_code not in all_insurance_codes, "同名异规格候选医保码撞主数据"
                detail = (f"名称与对照记录相同但规格「{spec}」无对应主数据，"
                          "绝不能并，应转存疑或新建")
            elif category == "换单位":
                value, strength_unit = convert_strength(target["_strength_value"], target["_strength_unit"])
                spec = (f"{fmt_num(value)}{strength_unit}*{target['_pack_count']}"
                        f"{target['_pack_unit']}")
                detail = (f"规格「{spec}」归一后等于对照「{target['spec']}」，"
                          "含量单位换算后相等，应并入对照记录")
            elif category == "停用码":
                detail = "唯一命中目标主数据状态为停用，不得自动并入，应转存疑"
            elif category == "医保码错配":
                insurance_code = f"XJ{9200000000000 + k:013d}"
                assert insurance_code not in all_insurance_codes, "医保码错配候选医保码撞主数据"
                detail = (f"名称规格与对照相同但医保码「{insurance_code}」全局无匹配，"
                          "不得仅凭名称相同就合并")

            note = (f"{category}|对照记录={target['record_id']}|期望={meta['expect']}|说明={detail}")
            submitted_at = (SIMULATED_BASE_TIME
                            + timedelta(minutes=start_minutes[category] + k * 7)).isoformat()
            candidates.append({
                "candidate_id": f"CAND-{meta['code']}-{k:03d}",
                "domain": "drug",
                "name": name,
                "spec": spec,
                "dosage_form": target["dosage_form"],
                "unit": target["unit"],
                "insurance_code": insurance_code,
                "submit_source": meta["submit_source"],
                "submitted_at": submitted_at,
                "source": SOURCE_TAG,
                "source_note": note,
            })
            cand_index += 1

    candidates.sort(key=lambda c: c["candidate_id"])
    return candidates


# ---------------------------------------------------------------------------
# 字段校验（真实执行，校验不过不产出坏数据）
# ---------------------------------------------------------------------------
def validate_master_data(records: list[dict[str, Any]]) -> dict[str, Any]:
    required = ("code", "record_id", "domain", "name", "status", "version")
    domains = {"drug", "fee_item", "department", "exam"}
    statuses = {"启用", "停用"}
    errors = {"missing_required": 0, "invalid_domain": 0, "invalid_status": 0, "invalid_version": 0}
    for record in records:
        for field in required:
            value = record.get(field)
            if value is None or value == "":
                errors["missing_required"] += 1
        if record.get("domain") not in domains:
            errors["invalid_domain"] += 1
        if record.get("status") not in statuses:
            errors["invalid_status"] += 1
        version = record.get("version", "")
        if not (isinstance(version, str) and version.startswith("v") and version[1:].isdigit()):
            errors["invalid_version"] += 1
    return {
        "checked": len(records),
        "required_fields": list(required),
        "errors": errors,
        "result": "pass" if sum(errors.values()) == 0 else "fail",
    }


def validate_candidates(records: list[dict[str, Any]], master_ids: set[str]) -> dict[str, Any]:
    required = ("candidate_id", "domain", "name", "source", "source_note")
    domains = {"drug", "fee_item", "department", "exam"}
    errors = {
        "missing_required": 0, "invalid_domain": 0, "invalid_source": 0,
        "unknown_category": 0, "missing_counterpart": 0, "missing_expectation": 0,
        "dangling_counterpart": 0,
    }
    for record in records:
        for field in required:
            value = record.get(field)
            if value is None or value == "":
                errors["missing_required"] += 1
        if record.get("domain") not in domains:
            errors["invalid_domain"] += 1
        if record.get("source") != SOURCE_TAG:
            errors["invalid_source"] += 1
        note = record.get("source_note", "")
        parts = note.split("|")
        if not parts or parts[0] not in CATEGORY_META:
            errors["unknown_category"] += 1
        counterpart = next((p.split("=", 1)[1] for p in parts if p.startswith("对照记录=")), None)
        expectation = next((p.split("=", 1)[1] for p in parts if p.startswith("期望=")), None)
        if not counterpart:
            errors["missing_counterpart"] += 1
        elif counterpart not in master_ids:
            errors["dangling_counterpart"] += 1
        if expectation not in {"merge", "non-merge", "uncertain"}:
            errors["missing_expectation"] += 1
    return {
        "checked": len(records),
        "required_fields": list(required),
        "errors": errors,
        "result": "pass" if sum(errors.values()) == 0 else "fail",
    }


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main() -> None:
    log(f"启动，deterministic_seed={DETERMINISTIC_SEED}，python 仅用标准库")
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)

    degradation: list[str] = []
    extra_names: list[str] = []
    local_path, local_text, local_attempts = resolve_local_catalog()
    if local_text is not None:
        extra_names = parse_official_text(local_text)
        log(f"层级 1 命中本地官方目录：{local_path.resolve()}，解析到 {len(extra_names)} 个候选通用名")
        degradation.append(f"层级 1 命中本地官方目录文件并解析 {len(extra_names)} 个通用名（仅作词表输入，记录仍由确定性仿真器构造）")
        final_source = "official-catalog:local"
    else:
        degradation.append(f"降级 1：本地官方药品目录文件不存在（已尝试 {len(local_attempts)} 个候选路径：{'；'.join(local_attempts)}）")
        log("降级 1：本地官方药品目录文件不存在，进入层级 2")

        url, downloaded_text, download_error = try_download()
        if downloaded_text is not None:
            parsed = parse_official_text(downloaded_text)
            if len(parsed) >= 60:
                extra_names = parsed
                log(f"层级 2 命中联网官方公开文件：{url}，解析到 {len(parsed)} 个候选通用名")
                degradation.append(f"层级 2 命中联网官方公开文件 {url} 并解析 {len(parsed)} 个通用名（仅作词表输入）")
                final_source = "official-catalog:download"
            else:
                reason = f"层级 2 下载 {url} 成功但仅解析到 {len(parsed)} 个规范通用名（采用阈值 60），内容不含结构化药品表"
                degradation.append(TIER2_MANIFEST_REASON)
                log(f"降级 2：{reason}，进入层级 3")
                final_source = SOURCE_TAG
        else:
            reason = f"层级 2 联网下载官方公开文件失败（超时上限 {DOWNLOAD_TIMEOUT_SECONDS}s）：{download_error}"
            degradation.append(TIER2_MANIFEST_REASON)
            log(f"降级 2：{reason}，进入层级 3")
            final_source = SOURCE_TAG

    if final_source == SOURCE_TAG:
        degradation.append(f"层级 3 采用配置化确定性仿真器（source={SOURCE_TAG}，deterministic_seed={DETERMINISTIC_SEED}，"
                           f"内置 {len(GENERIC_NAMES)} 个真实药典通用名 × {len(SPEC_TEMPLATES)} 种规格模板笛卡尔组合）")
        log(f"层级 3 启用配置化确定性仿真器，source={SOURCE_TAG}，seed={DETERMINISTIC_SEED}")

    names, added = build_generic_names(extra_names)
    master_internal, master_stats = build_master_data(names)
    master_ids = {r["record_id"] for r in master_internal}
    candidates = build_candidates(master_internal)

    # 导出时剔除下划线开头的内部结构字段
    master_export = [{k: v for k, v in r.items() if not k.startswith("_")} for r in master_internal]

    master_validation = validate_master_data(master_export)
    candidate_validation = validate_candidates(candidates, master_ids)
    if master_validation["result"] != "pass" or candidate_validation["result"] != "pass":
        raise RuntimeError(f"字段校验未通过，拒绝落盘：master={master_validation}, candidates={candidate_validation}")
    log(f"字段校验通过：master {master_validation['checked']} 条 / candidates {candidate_validation['checked']} 条")

    category_distribution: dict[str, Any] = {}
    for category in CATEGORY_ORDER:
        items = [c for c in candidates if c["source_note"].split("|", 1)[0] == category]
        category_distribution[category] = {
            "count": len(items),
            "source": SOURCE_TAG,
            "expected_direction": CATEGORY_META[category]["expect"],
            "counterpart_rule": CATEGORY_META[category]["detail"],
            "candidate_ids": [c["candidate_id"] for c in items],
        }

    master_text = to_json_text(master_export)
    candidates_text = to_json_text(candidates)
    (FIXTURE_DIR / "master-data.json").write_text(master_text, encoding="utf-8")
    (FIXTURE_DIR / "candidates.json").write_text(candidates_text, encoding="utf-8")
    log(f"已写入 master-data.json（{len(master_export)} 条）与 candidates.json（{len(candidates)} 条）")

    domain_distribution: dict[str, int] = {}
    status_distribution: dict[str, int] = {}
    for record in master_export:
        domain_distribution[record["domain"]] = domain_distribution.get(record["domain"], 0) + 1
        status_distribution[record["status"]] = status_distribution.get(record["status"], 0) + 1

    manifest: dict[str, Any] = {
        "manifest_version": "1.0",
        "dataset": "主数据归并检索系统 · 测试数据层（ChaosForge Phase 4 / Task 20）",
        "source": final_source,
        "generation_method": (
            "三级降级：层级 1 解析本地官方药品目录副本 → 层级 2 联网下载官方公开文件（urllib，超时<=5s）"
            " → 层级 3 配置化确定性仿真器。官方文本仅作通用名词表输入，最终记录统一由固定种子的仿真器构造。"
        ),
        "deterministic_seed": DETERMINISTIC_SEED,
        "python_stdlib_only": True,
        "script": "scripts/fetch_corpus.py",
        "simulator": {
            "builtin_generic_name_count": len(GENERIC_NAMES),
            "builtin_generic_names": GENERIC_NAMES,
            "official_parsed_name_count": len(extra_names),
            "official_parsed_names_added": added,
            "spec_template_count": len(SPEC_TEMPLATES),
            "spec_templates": [list(t) for t in SPEC_TEMPLATES],
            "brand_alias_mapping_count": len(BRAND_NAMES),
            "submitted_at_base": SIMULATED_BASE_TIME.isoformat(),
            "submitted_at_rule": "各候选 submitted_at = 固定基准时间 + (该类起始分钟 + 序号×7) 分钟，不用当前时间",
            "insurance_code_rule": "官方医保码风格 15 位：类别前缀 XJ + 13 位数字；主数据段 7000…/5000…/4000…/3000…，错配段 9100…/9200…",
            "code_rule": "院内主数据编码：drug=YP+6位，fee_item=FY+6位，department=KS+6位，exam=JC+6位",
            "record_id_rule": "MD- + 6 位序号，按序号升序稳定排序",
            "version_rule": "drug 按序号取 v1/v2，非药域为 v1",
        },
        "degradation": {
            "final_tier": 1 if local_text is not None else (2 if final_source == "official-catalog:download" else 3),
            "final_source": final_source,
            "download_attempted": local_text is None,
            "download_timeout_seconds": DOWNLOAD_TIMEOUT_SECONDS,
            "default_download_urls": DEFAULT_DOWNLOAD_URLS,
            "reasons": degradation,
        },
        "counts": {
            "master_data": len(master_export),
            "candidates": len(candidates),
            "total": len(master_export) + len(candidates),
            "drug_master": master_stats["drug_count"],
            "inactive_drug_master": master_stats["inactive_drug_count"],
            "enabled_drug_master": master_stats["enabled_drug_count"],
            "minimum_required": {"master_data": 300, "candidates": 150, "total": 450, "per_category": 30},
        },
        "domain_distribution": domain_distribution,
        "status_distribution": status_distribution,
        "category_distribution": category_distribution,
        "per_record_source": {
            "policy": "全部记录来源均为 final_source；主数据由确定性规则逐条生成，候选额外携带 source/source_note 与对照记录索引",
            "master_data_source": final_source,
            "candidates_source": final_source,
            "counterpart_index_rule": "每条候选 source_note 含 对照记录=<record_id> 与 期望=<merge|non-merge|uncertain>，可定位主数据对照与期望方向",
        },
        "record_index": {
            "master_data_record_ids": [r["record_id"] for r in master_export],
            "candidate_ids_by_category": {c: category_distribution[c]["candidate_ids"] for c in CATEGORY_ORDER},
        },
        "field_validation": {
            "master_data": master_validation,
            "candidates": candidate_validation,
            "file_sha256": {
                "master-data.json": sha256_text(master_text),
                "candidates.json": sha256_text(candidates_text),
            },
        },
        "benchmark_support": {
            "gate_case_categories": CATEGORY_ORDER,
            "expected_directions": {
                "merge": sum(1 for c in candidates if "|期望=merge|" in c["source_note"]),
                "non-merge": sum(1 for c in candidates if "|期望=non-merge|" in c["source_note"]),
                "uncertain": sum(1 for c in candidates if "|期望=uncertain|" in c["source_note"]),
            },
            "note": "5 类齐全，含应并/不应并/存疑三种期望方向，可被 gate-cases 与人工标注基准集复用，支撑错误归并率=0 对拍",
        },
        "generated_at": SIMULATED_BASE_TIME.isoformat(),
        "generating_note": "generated_at 为固定基准时间非当前时间，保证同输入重跑字节一致",
    }

    (FIXTURE_DIR / "MANIFEST.json").write_text(to_json_text(manifest), encoding="utf-8")
    log("已写入 MANIFEST.json（含来源、生成方式、条数、字段校验、5 类分布、降级原因、记录索引与文件 sha256）")
    distribution_text = ", ".join(
        f"{category}:{category_distribution[category]['count']}" for category in CATEGORY_ORDER
    )
    log(f"完成：source={final_source}，master={len(master_export)}，candidates={len(candidates)}，"
        f"5 类分布={{{distribution_text}}}")


if __name__ == "__main__":
    main()
