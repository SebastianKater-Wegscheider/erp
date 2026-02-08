export type Theme = "light" | "dark";

const STORAGE_KEY = "kater-wegscheider-company-theme";

export function getActiveTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore if storage is unavailable (e.g., restricted browser context).
  }
  applyTheme(theme);
}

export function toggleTheme(): Theme {
  const next: Theme = getActiveTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}
