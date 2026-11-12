import { useState, useEffect, useRef } from "react";
import { Outlet, useNavigate } from "react-router";
import { ViewProvider } from "@/providers/ViewContext";
import { SidebarProvider } from "@/providers/SidebarContext";
import SideBar from "@/components/ChatInterface/SideBar";
// import Footer from "@/components/Footer";
import type { ChatSession } from "@/providers/view";
import { useUser } from "@/providers/user";
import { fetchUserToken } from "@/lib/userToken";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const DEFAULT_WELCOME_MESSAGE =
  "Together we will try to find the right program for you. Click below to start a new conversation:";
const DEFAULT_DISCLAIMER = "AI can make mistakes. Check important info.";
// Minimum time between new chats, to absorb repeated clicks on slow devices
const NEW_CHAT_COOLDOWN_MS = 1500;

type UserProfile = {
  id: string;
  email: string | null;
  display_name?: string | null;
  role?: string;
  created_at?: string;
  last_seen_at?: string;
  messages_sent?: number;
  messages_window_started_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

type UpdateUserEmailResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      errorType:
        | "invalid_email"
        | "email_in_use"
        | "user_not_found"
        | "bad_request"
        | "unauthorized"
        | "server_error"
        | "network_error"
        | "unknown_error";
      message: string;
    };

export default function HomePage() {
  const { userId, isLoading: isLoadingUser } = useUser();
  const navigate = useNavigate();

  const isCreatingChatRef = useRef(false);
  const lastChatCreatedAtRef = useRef(0);

  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(
    null
  );
  const [currentMessages, setCurrentMessages] = useState<any[]>([]);
  const [activeChatName, setActiveChatName] = useState<string | null>(null);
  const [isLoadingChatSessions, setIsLoadingChatSessions] = useState(true);
  const [welcomeMessage, setWelcomeMessage] = useState<string>(
    DEFAULT_WELCOME_MESSAGE
  );
  const [isLoadingWelcome, setIsLoadingWelcome] = useState(true);
  const [disclaimer, setDisclaimer] = useState<string>(DEFAULT_DISCLAIMER);
  const [isLoadingDisclaimer, setIsLoadingDisclaimer] = useState(true);

  // Email / anonymity modal state
  const [isCheckingUserProfile, setIsCheckingUserProfile] = useState(true);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailChoiceStep, setEmailChoiceStep] = useState<"choice" | "email">(
    "choice"
  );
  const [emailInput, setEmailInput] = useState("");
  const [isSavingEmail, setIsSavingEmail] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const getAnonymousChoiceKey = (id: string) => `specEx_anonymous_choice_${id}`;

  const getPublicToken = async () => ({ token: await fetchUserToken() });

const normalizeChatSession = (session: any): ChatSession => ({
	id: session.id,
	name:
		typeof session.name === "string"
			? session.name
			: typeof session.title === "string"
				? session.title
				: "",
	user_id: session.user_id,
	context: session.context,
	created_at: session.created_at,
	metadata: session.metadata,
});

  const fetchSystemMessage = async (
    messageType: string,
    fallback: string,
    setter: (val: string) => void
  ) => {
    try {
      const { token } = await getPublicToken();

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/system_message/${messageType}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) throw new Error(`Failed to fetch ${messageType}`);

      const data: { message?: string } = await response.json();
      setter(data.message?.trim() || fallback);
    } catch (err) {
      console.error(`Error fetching ${messageType}:`, err);
      setter(fallback);
    }
  };

  const fetchUserProfile = async (id: string): Promise<UserProfile | null> => {
    try {
      const { token } = await getPublicToken();

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/user/${id}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch user profile");
      }

      return (await response.json()) as UserProfile;
    } catch (err) {
      console.error("Error fetching user profile:", err);
      return null;
    }
  };

  const updateUserEmail = async (
    id: string,
    email: string
  ): Promise<UpdateUserEmailResult> => {
    try {
      const { token } = await getPublicToken();

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/user/${id}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email }),
        }
      );

      let responseBody: any = null;

      try {
        responseBody = await response.json();
      } catch {
        responseBody = null;
      }

      if (response.ok) {
        return {
          ok: true,
          data: responseBody,
        };
      }

      const backendMessage =
        responseBody?.error || responseBody?.message || "Something went wrong.";

      switch (response.status) {
        case 400: {
          const normalizedMessage = String(backendMessage).toLowerCase();

          if (
            normalizedMessage.includes("invalid email") ||
            normalizedMessage.includes("email format")
          ) {
            return {
              ok: false,
              errorType: "invalid_email",
              message: "Please enter a valid email address.",
            };
          }

          return {
            ok: false,
            errorType: "bad_request",
            message: backendMessage,
          };
        }

        case 401:
          return {
            ok: false,
            errorType: "unauthorized",
            message: "You are not authorized. Please refresh and try again.",
          };

        case 404:
          return {
            ok: false,
            errorType: "user_not_found",
            message: "We could not find your user account. Please refresh and try again.",
          };

        case 409:
          return {
            ok: false,
            errorType: "email_in_use",
            message: "That email is already in use.",
          };

        case 500:
          return {
            ok: false,
            errorType: "server_error",
            message: "A server error occurred. Please try again.",
          };

        default:
          return {
            ok: false,
            errorType: "unknown_error",
            message: backendMessage,
          };
      }
    } catch (err) {
      console.error("Error updating user email:", err);
      return {
        ok: false,
        errorType: "network_error",
        message: "Unable to reach the server. Check your connection and try again.",
      };
    }
  };

  const checkWhetherToPromptForEmail = async (id: string) => {
    setIsCheckingUserProfile(true);

    try {
      const profile = await fetchUserProfile(id);

      if (!profile) {
        setShowEmailModal(false);
        return;
      }

      const hasEmail = Boolean(profile.email?.trim());
      const anonymousChoice = localStorage.getItem(getAnonymousChoiceKey(id));

      if (!hasEmail && anonymousChoice !== "true") {
        setShowEmailModal(true);
        setEmailChoiceStep("choice");
      } else {
        setShowEmailModal(false);
      }
    } finally {
      setIsCheckingUserProfile(false);
    }
  };

  // Fetch chat sessions for the user
  const fetchChatSessions = async () => {
    if (!userId) {
      setIsLoadingChatSessions(false);
      return;
    }

    setIsLoadingChatSessions(true);
    try {
      const { token } = await getPublicToken();

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/chat_sessions/user/${userId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch chat sessions");
      }

      const sessions: unknown = await response.json();
      setChatSessions(Array.isArray(sessions) ? sessions.map(normalizeChatSession) : []);
    } catch (err) {
      console.error("Error fetching chat sessions:", err);
    } finally {
    		setIsLoadingChatSessions(false);
    }
  };

  useEffect(() => {
    if (isLoadingUser) return;

    setIsLoadingWelcome(true);
    setIsLoadingDisclaimer(true);

    Promise.all([
      fetchSystemMessage("welcome_message", DEFAULT_WELCOME_MESSAGE, setWelcomeMessage),
      fetchSystemMessage("disclaimer", DEFAULT_DISCLAIMER, setDisclaimer),
    ]).finally(() => {
      setIsLoadingWelcome(false);
      setIsLoadingDisclaimer(false);
    });

    fetchChatSessions();

    if (userId) {
      checkWhetherToPromptForEmail(userId);
    } else {
      setIsCheckingUserProfile(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, isLoadingUser]);

  // Create a new chat session. Repeat requests are ignored while one is in flight and for a
  // short time afterwards, so impatient clicks on a slow device do not create extra chats.
  const createNewChatSession = async (): Promise<ChatSession | null> => {
    if (!userId) return null;
    if (isCreatingChatRef.current) return null;
    if (Date.now() - lastChatCreatedAtRef.current < NEW_CHAT_COOLDOWN_MS) return null;

    isCreatingChatRef.current = true;
    try {
      const { token } = await getPublicToken();

      const createResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/chat_sessions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      );

      if (!createResponse.ok) {
        throw new Error("Failed to create chat session");
      }

      const newSession = normalizeChatSession(await createResponse.json());

      // Add to the list and set as active
      setChatSessions((prev) => [newSession, ...prev]);
      setActiveChatSessionId(newSession.id);
      lastChatCreatedAtRef.current = Date.now();

      return newSession;
    } catch (err) {
      console.error("Error creating chat session:", err);
      return null;
    } finally {
      isCreatingChatRef.current = false;
    }
  };

  const refreshChatSessions = async () => {
    await fetchChatSessions();
  };

  // Update chat session name locally
  const updateChatSessionName = (sessionId: string, name: string) => {
    setChatSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId ? { ...session, name } : session
      )
    );
  };

  const removeChatSession = (sessionId: string) => {
    setChatSessions((prev) => prev.filter((session) => session.id !== sessionId));
    setActiveChatSessionId((current) => (current === sessionId ? null : current));
  };

  const renameChatSession = async (
    sessionId: string,
    name: string
  ): Promise<ChatSession | null> => {
    if (!userId) return null;

    const trimmedName = name.trim();
    if (!trimmedName) return null;

    try {
      const { token } = await getPublicToken();

      const url = new URL(`${import.meta.env.VITE_API_ENDPOINT}/chat_sessions/${sessionId}`);

      const response = await fetch(url.toString(), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: trimmedName }),
      });

      if (!response.ok) {
        throw new Error("Failed to rename chat session");
      }

      const updatedSession = normalizeChatSession(await response.json());
      setChatSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId ? { ...session, ...updatedSession } : session
        )
      );

      return updatedSession;
    } catch (err) {
      console.error("Error renaming chat session:", err);
      return null;
    }
  };

  // Welcome CTA action
  const handleStartNewConversation = async () => {
    const session = await createNewChatSession();
    if (session) {
      navigate("/chat");
    }
  };

  const handleStayAnonymous = () => {
    if (!userId) return;
    localStorage.setItem(getAnonymousChoiceKey(userId), "true");
    setShowEmailModal(false);
  };

  const handleUseEmail = () => {
    setEmailChoiceStep("email");
    setEmailError(null);
  };

  const handleSaveEmail = async () => {
    if (!userId) return;

    const normalizedEmail = emailInput.trim().toLowerCase();

    if (!normalizedEmail) {
      setEmailError("Please enter an email address.");
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      setEmailError("Please enter a valid email address.");
      return;
    }

    setIsSavingEmail(true);
    setEmailError(null);

    const result = await updateUserEmail(userId, normalizedEmail);

    if (result.ok) {
      localStorage.removeItem(getAnonymousChoiceKey(userId));
      setShowEmailModal(false);
      setEmailInput("");
      setIsSavingEmail(false);
      return;
    }

    switch (result.errorType) {
      case "invalid_email":
        setEmailError("Please enter a valid email address.");
        break;

      case "email_in_use":
        setEmailError("That email is already associated with another account.");
        break;

      case "user_not_found":
        setEmailError("Your session could not be found. Please refresh the page.");
        break;

      case "unauthorized":
        setEmailError("Your session expired. Please refresh and try again.");
        break;

      case "network_error":
        setEmailError("Could not connect to the server. Please check your connection.");
        break;

      case "server_error":
        setEmailError("Something went wrong on our side. Please try again.");
        break;

      case "bad_request":
      case "unknown_error":
      default:
        setEmailError(result.message || "We couldn't save your email.");
        break;
    }

    setIsSavingEmail(false);
  };

  // Show loading screen while fetching initial data
  if (isLoadingUser || isLoadingChatSessions || isCheckingUserProfile) {
    return (
      <div className="flex flex-col min-h-screen bg-background">
        <div className="pt-[70px] flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ViewProvider
      value={{
        loading: false,
        error: null,
        chatSessions,
        activeChatSessionId,
        setActiveChatSessionId,
        isLoadingChatSessions,
        createNewChatSession,
        refreshChatSessions,
        updateChatSessionName,
        removeChatSession,
        renameChatSession,
        currentMessages,
        setCurrentMessages,
        activeChatName,
        setActiveChatName,
      }}
    >
      <SidebarProvider>
        <div className="flex flex-col h-full bg-background overflow-hidden">
          <SideBar />
          <div className="md:ml-64 flex flex-col flex-1 min-h-0">
            <main
              className={`flex-1 flex flex-col items-center max-w-screen px-4 min-h-0 ${
                activeChatSessionId ? "justify-start overflow-hidden" : "justify-center"
              }`}
            >
              {!activeChatSessionId ? (
                <div className="w-full max-w-2xl text-center">
                  <h1 className="text-3xl md:text-4xl font-bold mb-4 leading-tight">
                    Welcome to Specialization Explorer!
                  </h1>

                  <p className="text-base md:text-lg text-muted-foreground mb-8 whitespace-pre-line">
                    {isLoadingWelcome ? "Loading..." : welcomeMessage}
                  </p>

                  <Button
                    size="lg"
                    onClick={handleStartNewConversation}
                    className="px-8"
                    disabled={isLoadingWelcome}
                  >
                    Start a new conversation
                  </Button>

                  <p className="mt-4 text-xs text-muted-foreground">
                    {isLoadingDisclaimer ? "" : disclaimer}
                  </p>
                </div>
              ) : (
                <Outlet />
              )}
            </main>
            {/* <Footer /> */}
          </div>

          <Dialog open={showEmailModal}>
            <DialogContent
              className="sm:max-w-md"
              onEscapeKeyDown={(e) => e.preventDefault()}
              onInteractOutside={(e) => e.preventDefault()}
            >
              <DialogHeader>
                <DialogTitle>Would you like to stay anonymous?</DialogTitle>
                <DialogDescription>
                  You can continue anonymously, or provide your email so we can
                  associate it with your account.
                </DialogDescription>
              </DialogHeader>

              {emailChoiceStep === "choice" ? (
                <div className="flex flex-col gap-3 pt-2">
                  <Button onClick={handleStayAnonymous}>
                    Yes, stay anonymous
                  </Button>
                  <Button variant="outline" onClick={handleUseEmail}>
                    No, I want to enter my email
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-3 pt-2">
                  <Input
                    type="email"
                    placeholder="Enter your email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    disabled={isSavingEmail}
                  />

                  {emailError ? (
                    <p className="text-sm text-destructive">{emailError}</p>
                  ) : null}

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setEmailChoiceStep("choice");
                        setEmailError(null);
                      }}
                      disabled={isSavingEmail}
                    >
                      Back
                    </Button>
                    <Button onClick={handleSaveEmail} disabled={isSavingEmail}>
                      {isSavingEmail ? "Saving..." : "Save email"}
                    </Button>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </SidebarProvider>
    </ViewProvider>
  );
}
