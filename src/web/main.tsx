import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { MastraReactProvider } from "@mastra/react";
import { App } from "./App";
import "@mastra/react/styles.css";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 2_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <MastraReactProvider baseUrl="" apiPrefix="/api" credentials="same-origin">
      <BrowserRouter><App /></BrowserRouter>
    </MastraReactProvider>
  </QueryClientProvider>,
);
