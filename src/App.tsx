import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ChatProvider } from "@/contexts/ChatContext";
import { CrisisSupervisionProvider } from "@/contexts/CrisisSupervisionContext";
import Login from "./pages/Login";
import Chat from "./pages/Chat";
import CalmMode from "./pages/CalmMode";
import Pomoc from "./pages/Pomoc";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <CrisisSupervisionProvider>
      <ChatProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Login />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/calm" element={<CalmMode />} />
            <Route path="/pomoc" element={<Pomoc />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </ChatProvider>
      </CrisisSupervisionProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
