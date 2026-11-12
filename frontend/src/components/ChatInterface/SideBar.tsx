import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/providers/sidebar";
import { useNavigate } from "react-router";
import { Separator } from "@/components/ui/separator";
import { useView } from "@/providers/view";
import { Plus, MessageSquare } from "lucide-react";
import ChatSessionActionsMenu from "./ChatSessionActionsMenu";

type SidebarContentProps = {
  setMobileOpen: (open: boolean) => void;
};

function SidebarContent({
  setMobileOpen,
}: SidebarContentProps) {
  const navigate = useNavigate();
  const {
    chatSessions,
    activeChatSessionId,
    setActiveChatSessionId,
    createNewChatSession,
    removeChatSession,
  } = useView();

  const [isCreatingChat, setIsCreatingChat] = useState(false);

  const handleNewChat = async () => {
    if (isCreatingChat) return;
    setIsCreatingChat(true);
    try {
      const newSession = await createNewChatSession();
      if (newSession) {
        navigate(`/chat`);
        setMobileOpen(false);
      }
    } finally {
      setIsCreatingChat(false);
    }
  };

  const handleSelectSession = (sessionId: string) => {
    setActiveChatSessionId(sessionId);
    navigate(`/chat`);
    setMobileOpen(false);
  };

  // No debug logs here; keep dialog state local

  return (
    <>
      {/* Menu Items */}

      <div className="mb-2">
        <div className="flex items-center justify-between mb-2">
          <h3 className="px-3 text-xs font-semibold text-muted-foreground tracking-wide">
            CHATS
          </h3>
          <Button
            variant="link"
            size="icon"
            onClick={handleNewChat}
            disabled={isCreatingChat}
            className="text-muted-foreground hover:text-foreground cursor-pointer h-6 w-6 disabled:opacity-50 disabled:cursor-not-allowed"
            title="New chat"
            aria-label="New chat"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {/* Chat sessions list */}
        <div className="pl-2 border-l-2 border-muted space-y-1 max-h-[300px] overflow-y-auto">
          {chatSessions.map((session, index) => (
            <div
              key={session.id}
              className={`flex items-center gap-1 rounded-md transition-colors ${activeChatSessionId === session.id
                ? "bg-accent/60"
                : "hover:bg-accent/30"
                }`}
            >
              <Button
                variant="link"
                onClick={() => handleSelectSession(session.id)}
                className={`flex-1 justify-start px-3 py-2 text-sm rounded-md transition-colors ${activeChatSessionId === session.id
                  ? "text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:underline"
                  }`}
              >
                <MessageSquare className="h-4 w-4 mr-2 flex-shrink-0" />
                <span className="truncate">
                  {session.name || `Chat ${chatSessions.length - index}`}
                </span>
              </Button>

              <div className="pr-1">
                <ChatSessionActionsMenu
                  chatSessionId={session.id}
                  chatSessionName={session.name || ""}
                  displayName={session.name || `Chat ${chatSessions.length - index}`}
                  isActive={activeChatSessionId === session.id}                  onDeleted={async () => {
                    removeChatSession(session.id);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      <Separator className="mb-4" />
    </>
  );
}

export default function SideBar() {
  const { mobileOpen, setMobileOpen } = useSidebar();

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block fixed left-0 p-[10px] h-screen w-64 flex-shrink-0 border bg-muted overflow-auto px-4">
        <SidebarContent
          setMobileOpen={setMobileOpen}
        />
      </aside>

      {/* Mobile sidebar */}
      <div
        className={`md:hidden pt-[10px] fixed inset-0 z-40 transition-opacity ${mobileOpen ? "visible" : "pointer-events-none invisible"
          }`}
        inert={!mobileOpen ? true : undefined}
      >
        {/*mobile backdrop */}
        <div
          className={`absolute inset-0 bg-black/40 ${mobileOpen ? "opacity-100" : "opacity-0"
            }`}
          onClick={() => setMobileOpen(false)}
        />

        {/* mobile view Panel */}
        <div
          className={`pt-[70px] absolute left-0  h-full w-64 bg-muted border-r p-4 transform transition-transform ${mobileOpen ? "translate-x-0" : "-translate-x-full"
            }`}
        >
          <SidebarContent
            setMobileOpen={setMobileOpen}
          />
        </div>
      </div>
    </>
  );
}
