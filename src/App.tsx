import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ChatProvider } from "@/contexts/ChatContext";
import { CrisisSupervisionProvider } from "@/contexts/CrisisSupervisionContext";
import { ActiveSessionsProvider } from "@/contexts/ActiveSessionsContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Login from "./pages/Login";
import Hub from "./pages/Hub";
import Chat from "./pages/Chat";
import CalmMode from "./pages/CalmMode";
import Kartoteka from "./pages/Kartoteka";
import Zklidneni from "./pages/Zklidneni";
import Pomoc from "./pages/Pomoc";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// Detect if running on pomoc.* subdomain
const isPomocSubdomain = window.location.hostname.startsWith("pomoc.");

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <CrisisSupervisionProvider>
      <ActiveSessionsProvider>
      <ChatProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            {isPomocSubdomain ? (
              <>
                <Route path="/" element={<Pomoc />} />
                <Route path="/pomoc" element={<Pomoc />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </>
            ) : (
              <>
                <Route path="/" element={<Login />} />
                <Route path="/hub" element={<ProtectedRoute><Hub /></ProtectedRoute>} />
                <Route path="/chat" element={<ProtectedRoute><Chat /></ProtectedRoute>} />
                <Route path="/kartoteka" element={<ProtectedRoute><Kartoteka /></ProtectedRoute>} />
                <Route path="/calm" element={<ProtectedRoute><CalmMode /></ProtectedRoute>} />
                <Route path="/zklidneni" element={<Zklidneni />} />
                <Route path="/pomoc" element={<Pomoc />} />
                <Route path="*" element={<NotFound />} />
              </>
            )}
          </Routes>
        </BrowserRouter>
      </ChatProvider>
      </ActiveSessionsProvider>
      </CrisisSupervisionProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
