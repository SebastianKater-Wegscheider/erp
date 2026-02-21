import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

import "./styles/global.css";
import "leaflet/dist/leaflet.css";
import { applyTheme, getInitialTheme } from "./app/theme";
import { App } from "./App";
import { AuthProvider } from "./auth/auth";

applyTheme(getInitialTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  </React.StrictMode>,
);
