export type Theme = "light" | "dark";

const STORAGE_KEY = "erp.v2.theme";

export function getTheme(): Theme {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "dark" ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme) {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

export function getInitialTheme(): Theme {
  try {
    return getTheme();
  } catch {
    return "light";
  }
}

