// Intervals.icu API 客户端（只在服务端使用，API Key 不暴露给前端）

const ICU_BASE = "https://intervals.icu/api/v1";

function authHeader(apiKey) {
  // ICU 使用 HTTP Basic 认证：用户名固定为 "API_KEY"，密码是你的 Key
  const token = Buffer.from("API_KEY:" + apiKey).toString("base64");
  return { Authorization: "Basic " + token };
}

async function icuFetch(path, { apiKey, method = "GET", body, query } = {}) {
  const url = new URL(ICU_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== null && v !== undefined) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url, {
    method,
    headers: { ...authHeader(apiKey), "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`ICU ${res.status}: ${text.slice(0, 600)}`);
    err.status = res.status;
    throw err;
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? await res.json() : await res.text();
}

// 运动员 ID：
// - 留空或 "0" → 0，ICU 会按 API Key 所属账号解析（athlete/0 = Key 的主人）
// - ICU 网页地址形如 /athlete/i464783，API 用的也是带 i 前缀的 id；
//   纯数字（如 464783）会自动加 i 前缀——直接传纯数字会命中别的运动员，返回 403。
function athleteId(id) {
  const s = String(id ?? "").trim();
  if (!s || s === "0") return "0";
  if (/^\d+$/.test(s)) return "i" + s;
  return s[0] === "I" ? "i" + s.slice(1) : s;
}

// 活动类接口的 id 同样要带 i 前缀（/activity/i209987472 有效，纯数字 404）
function activityId(id) {
  const s = String(id ?? "").trim();
  return /^\d+$/.test(s) ? "i" + s : s;
}

export function createIcuClient(apiKey, rawAthleteId) {
  const aid = athleteId(rawAthleteId);

  // 运动员相关接口：先用页面填的运动员 ID 请求；
  // 若 403/404（Key 与该运动员不匹配，ICU Key 是跟着运动员走的），自动退回 Key 所属账号（0）。
  async function athletePath(path, opts = {}) {
    if (aid === 0) return icuFetch(`/athlete/0${path}`, { apiKey, ...opts });
    try {
      return await icuFetch(`/athlete/${aid}${path}`, { apiKey, ...opts });
    } catch (e) {
      if (e.status === 403 || e.status === 404) {
        return icuFetch(`/athlete/0${path}`, { apiKey, ...opts });
      }
      throw e;
    }
  }

  return {
    athleteId: aid,

    async profile() {
      const p = await athletePath("");
      if (!p || typeof p !== "object") return p;
      // ICU profile 不直接给 ftp/weight，字段位置较深，这里统一归一到顶层，
      // 供概览页与提示词直接使用（全部实时读取，随 ICU 设置变化）：
      // - FTP：Ride 运动设置（户外 ftp / 室内 indoor_ftp）
      // - 体重：icu_weight
      // - 最大心率/LTHR/W'/峰值功率：Ride 运动设置
      const ride = Array.isArray(p.sportSettings)
        ? p.sportSettings.find(
            (s) => Array.isArray(s.types) && s.types.includes("Ride")
          )
        : null;
      const ftp = ride?.ftp ?? ride?.indoor_ftp ?? p.icu_ftp ?? null;
      const weight = p.icu_weight ?? p.weight ?? null;
      return {
        ...p,
        ftp,
        indoor_ftp: ride?.indoor_ftp ?? null,
        weight,
        weight_kg: weight,
        max_hr: ride?.max_hr ?? null,
        lthr: ride?.lthr ?? null,
        w_prime: ride?.w_prime ?? null,
        p_max: ride?.p_max ?? null,
        resting_hr: p.icu_resting_hr ?? null,
      };
    },

    // 最新一条 fitness（含 CTL/ATL/Form）。
    // 部分账号的 /fitness 恒 404（ICU 未生成 fitness 历史）：
    // 此时用最新一条 wellness（自带每日 ctl/atl）兜底，并计算 form = ctl - atl。
    async latestFitness() {
      try {
        const list = await athletePath("/fitness");
        if (Array.isArray(list) && list.length > 0) return list[list.length - 1];
      } catch (e) {
        // /fitness 404 → 走 wellness 兜底
      }
      const w = await this.wellness(1);
      if (!w.length) return null;
      const w0 = w[0];
      return {
        id: w0.id,
        ctl: w0.ctl ?? 0,
        atl: w0.atl ?? 0,
        form: Math.round(((w0.ctl ?? 0) - (w0.atl ?? 0)) * 100) / 100,
        rampRate: w0.rampRate ?? null,
        ctlLoad: w0.ctlLoad ?? 0,
        atlLoad: w0.atlLoad ?? 0,
        fromWellness: true,
      };
    },

    // 最近若干条 wellness（HRV/睡眠/readiness）
    async wellness(limit = 14) {
      const list = await athletePath("/wellness");
      if (!Array.isArray(list)) return [];
      return list.slice(-limit).reverse();
    },

    // HRV/静息心率基线：用最近 N 天 wellness 算均值（30 天长期基线 + 7 天近期趋势）
    async wellnessBaseline(days = 30) {
      const list = await this.wellness(days);
      const avg = (arr) => {
        const vals = arr.filter((v) => typeof v === "number" && Number.isFinite(v));
        if (!vals.length) return null;
        return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
      };
      return {
        days: list.length,
        hrv_30d: avg(list.map((x) => x.hrv)),
        hrv_7d: avg(list.slice(0, 7).map((x) => x.hrv)),
        rhr_30d: avg(list.map((x) => x.restingHR)),
        rhr_7d: avg(list.slice(0, 7).map((x) => x.restingHR)),
        sleep_7d: avg(list.slice(0, 7).map((x) => (x.sleepSecs ? x.sleepSecs / 3600 : null))),
      };
    },

    // 最近的训练活动
    async activities({ oldest, newest } = {}) {
      const list = await athletePath("/activities", { query: { oldest, newest } });
      return Array.isArray(list) ? list : [];
    },

    // 日历事件（计划课表）
    async events({ oldest, newest } = {}) {
      const list = await athletePath("/events", { query: { oldest, newest } });
      return Array.isArray(list) ? list : [];
    },

    // 回写课表：逐个创建（返回解析后的 workout_doc）
    async writeWorkouts(workouts) {
      const created = [];
      for (const w of workouts) {
        const body = {
          category: "WORKOUT",
          type: w.type || "Ride",
          name: w.name,
          start_date_local: w.start_date_local,
          description: w.description,
        };
        if (w.moving_time) body.moving_time = w.moving_time;
        const ev = await athletePath("/events", { method: "POST", body });
        created.push(ev);
      }
      return created;
    },

    // 批量创建/更新日历事件（用 external_id 保证幂等，重复写入不会产生重复事件）
    async upsertEvents(events) {
      return athletePath("/events/bulk", {
        method: "POST",
        body: events,
        query: { upsert: "true" },
      });
    },

    // 单个活动详情（含 ICU 自动分段 icu_intervals）
    async activity(id) {
      return icuFetch(`/activity/${activityId(id)}`, { apiKey });
    },

    // 更新活动（只修改传入的字段）
    async updateActivity(id, patch) {
      return icuFetch(`/activity/${activityId(id)}`, { apiKey, method: "PUT", body: patch });
    },

    // 活动流数据（功率/心率逐秒数组，可能不可用，调用方需容错）
    async activityStreams(id) {
      return icuFetch(`/activity/${activityId(id)}/streams`, { apiKey });
    },
  };
}
