import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";
import { setIpfsApi } from "./ipfs.mjs";

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [config, setConfig] = useState(null);
  const [ready, setReady] = useState(false);
  const [startupError, setStartupError] = useState("");

  const loadConfig = useCallback(async () => {
    const next = await api.get("/config");
    setIpfsApi(next.ipfsApi);
    setConfig(next);
    return next;
  }, []);

  useEffect(() => {
    Promise.all([api.get("/auth/me"), loadConfig()])
      .then(([me]) => setUser(me.user))
      .catch((e) => setStartupError(e.message))
      .finally(() => setReady(true));
  }, [loadConfig]);

  const login = async (email, password) => {
    const { user: next } = await api.post("/auth/login", { email, password });
    setUser(next);
    return next;
  };

  const demoLogin = async (email) => {
    const { user: next } = await api.post("/auth/demo", { email });
    setUser(next);
    return next;
  };

  const signup = async (details) => {
    const { user: next } = await api.post("/auth/signup", details);
    await loadConfig();
    setUser(next);
    return next;
  };

  const logout = async () => {
    await api.post("/auth/logout");
    setUser(null);
  };

  const refresh = async () => {
    const { user: next } = await api.get("/auth/me");
    setUser(next);
    return next;
  };

  return (
    <AuthContext.Provider value={{ user, setUser, config, ready, startupError, login, demoLogin, signup, logout, refresh, loadConfig }}>
      {children}
    </AuthContext.Provider>
  );
}
