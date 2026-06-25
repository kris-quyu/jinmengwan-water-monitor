const API_BASE = "";

const Api = (() => {
  const TOKEN_KEY = "jmw_access_token";
  const FARM_KEY = "jmw_selected_farm";

  function token() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  async function request(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token()) headers.Authorization = `Bearer ${token()}`;
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (response.status === 401 && !path.includes("/auth/login")) {
      clearSession();
      window.location.href = "login.html";
      throw new Error("登录已失效");
    }
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }
    if (!response.ok) throw new Error(data?.detail || `请求失败 (${response.status})`);
    return data;
  }

  function query(path, params = {}) {
    const filtered = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "");
    const search = new URLSearchParams(filtered).toString();
    return `${path}${search ? `?${search}` : ""}`;
  }

  function selectedFarmId() {
    const value = Number(localStorage.getItem(FARM_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function setSelectedFarmId(farmId) {
    localStorage.setItem(FARM_KEY, String(farmId));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(FARM_KEY);
  }

  return {
    login: async (username, password) => {
      const result = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      localStorage.setItem(TOKEN_KEY, result.access_token);
      return result;
    },
    logout: clearSession,
    hasToken: () => Boolean(token()),
    getMe: () => request("/api/auth/me"),
    getFarms: () => request("/api/farms"),
    getPonds: farmId => request(query("/api/ponds", { farm_id: farmId })),
    getDashboard: farmId => request(query("/api/dashboard", { farm_id: farmId })),
    getLatestData: farmId => request(query("/api/latest", { farm_id: farmId })),
    getHistoryData: (metric, range, farmId, pondId) =>
      request(query("/api/history", { metric, range, farm_id: farmId, pond_id: pondId })),
    getAlarmList: farmId => request(query("/api/alarms", { farm_id: farmId })),
    handleAlarm: alarmId => request(`/api/alarms/${alarmId}/handle`, { method: "POST" }),
    getSensorList: farmId => request(query("/api/sensors", { farm_id: farmId })),
    getSettings: farmId => request(query("/api/settings", { farm_id: farmId })),
    saveSettings: settings => request("/api/settings", { method: "POST", body: JSON.stringify(settings) }),
    getFeedingPlans: farmId => request(query("/api/feeding/plans", { farm_id: farmId })),
    saveFeedingPlan: plan => request("/api/feeding/plans", { method: "POST", body: JSON.stringify(plan) }),
    getCameras: farmId => request(query("/api/cameras", { farm_id: farmId })),
    getAdminUsers: () => request("/api/admin/users"),
    createUser: payload => request("/api/admin/users", { method: "POST", body: JSON.stringify(payload) }),
    createFarm: payload => request("/api/admin/farms", { method: "POST", body: JSON.stringify(payload) }),
    selectedFarmId,
    setSelectedFarmId
  };
})();
