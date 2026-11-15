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

// 运动员 ID：留空则用 API Key 所属账号（0）
function athleteId(id) {
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function createIcuClient(apiKey, rawAthleteId) {
  const aid = athleteId(rawAthleteId);
  return {
    athleteId: aid,

    async profile() {
      return icuFetch(`/athlete/${aid}`, { apiKey });
    },

    // 最新一条 fitness（含 CTL/ATL/Form）
    async latestFitness() {
      const list = await icuFetch(`/athlete/${aid}/fitness`, { apiKey });
      if (!Array.isArray(list) || list.length === 0) return null;
      // 返回最后一条（按日期升序）
      return list[list.length - 1];
    },

    // 最近若干条 wellness（HRV/睡眠/readiness）
    async wellness(limit = 14) {
      const list = await icuFetch(`/athlete/${aid}/wellness`, { apiKey });
      if (!Array.isArray(list)) return [];
      return list.slice(-limit).reverse();
    },

    // 最近的训练活动
    async activities({ oldest, newest } = {}) {
      const list = await icuFetch(`/athlete/${aid}/activities`, {
        apiKey,
        query: { oldest, newest },
      });
      return Array.isArray(list) ? list : [];
    },

    // 日历事件（计划课表）
    async events({ oldest, newest } = {}) {
      const list = await icuFetch(`/athlete/${aid}/events`, {
        apiKey,
        query: { oldest, newest },
      });
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
        const ev = await icuFetch(`/athlete/${aid}/events`, {
          apiKey,
          method: "POST",
          body,
        });
        created.push(ev);
      }
      return created;
    },

    // 批量创建/更新日历事件（用 external_id 保证幂等，重复写入不会产生重复事件）
    async upsertEvents(events) {
      return icuFetch(`/athlete/${aid}/events/bulk`, {
        apiKey,
        method: "POST",
        body: events,
        query: { upsert: "true" },
      });
    },

    // 单个活动详情（含 ICU 自动分段 icu_intervals）
    async activity(id) {
      return icuFetch(`/activity/${id}`, { apiKey });
    },

    // 更新活动（只修改传入的字段）
    async updateActivity(id, patch) {
      return icuFetch(`/activity/${id}`, { apiKey, method: "PUT", body: patch });
    },

    // 活动流数据（功率/心率逐秒数组，可能不可用，调用方需容错）
    async activityStreams(id) {
      return icuFetch(`/activity/${id}/streams`, { apiKey });
    },
  };
}
