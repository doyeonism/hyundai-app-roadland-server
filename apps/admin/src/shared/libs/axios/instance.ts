import axios from "axios";
import { getBaseUrl } from "./base-url";
import { refreshAccessToken } from "./interceptors";

const axiosInstance = axios.create({
  baseURL: getBaseUrl(),
  headers: {
    "Content-Type": "application/json",
  },
  withCredentials: true,
});

// 매 요청 시점에 런타임 baseURL 적용 (인증은 httpOnly 쿠키로 처리되어 별도 헤더 주입 불필요)
axiosInstance.interceptors.request.use((config) => {
  config.baseURL = getBaseUrl();
  return config;
}, (error) => {
  return Promise.reject(error);
});

axiosInstance.interceptors.response.use(
  (response) => response,
  refreshAccessToken,
);

export { axiosInstance, getBaseUrl };
