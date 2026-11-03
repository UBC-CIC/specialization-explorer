import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { confirmSignIn, type SignInOutput } from "aws-amplify/auth";
import { Eye, EyeOff } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { AuthService } from "@/functions/authService";
import Footer from "@/components/Footer";

// Name shown for this account in the administrator's authenticator app
const TOTP_ISSUER = "Specialization Explorer";

// The pool requires an authenticator app (TOTP) code on every sign-in. A new administrator sets a
// password, then enrolls an app, then enters a code; later sign-ins go straight to the code.
// https://docs.amplify.aws/react/build-a-backend/auth/concepts/multi-factor-authentication/
type Step = "credentials" | "newPassword" | "totpSetup" | "totpCode";

const STEP_TEXT: Record<Step, { title: string; description: string }> = {
  credentials: {
    title: "Admin Login",
    description: "Enter your credentials to access the admin dashboard",
  },
  newPassword: {
    title: "Set New Password",
    description: "Please set a new password for your account",
  },
  totpSetup: {
    title: "Set Up Authenticator App",
    description: "Administrator accounts require an authenticator app code at every sign-in",
  },
  totpCode: {
    title: "Enter Authentication Code",
    description: "Enter the 6-digit code from your authenticator app",
  },
};

const TOTP_CODE_REGEX = /^\d{6}$/;

// Groups the setup key in blocks of four so it is easier to type into an app
const formatSecret = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();

export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [totpSetupUri, setTotpSetupUri] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState<Step>("credentials");
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as any)?.from?.pathname || "/admin/dashboard";

  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        const session = await AuthService.getAuthSession(true);
        if (session?.tokens?.accessToken) {
          // User is already authenticated, redirect to dashboard
          navigate(from, { replace: true });
        }
      } catch (error) {
        // User is not authenticated, stay on login page
        console.log("Not authenticated");
      }
    };

    checkAuthStatus();
  }, [navigate]);

  const updateAdminUser = async () => {
    const session = await AuthService.getAuthSession(true);
    const token = session.tokens.idToken;

    const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/promote_user`, {
      method: "POST",
      headers: {
        Authorization: token,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to update admin user: ${res.status} ${text}`);
    }

    return res.json();
  };

  const completeSignIn = async () => {
    // Clear cache to ensure fresh session
    AuthService.clearAuthCache();
    await updateAdminUser();
    navigate(from, { replace: true });
  };

  // Moves to the screen for the next sign-in step, or finishes sign-in
  const handleSignInResult = async (result: Pick<SignInOutput, "isSignedIn" | "nextStep">) => {
    if (result.isSignedIn) {
      await completeSignIn();
      return;
    }

    const { nextStep } = result;
    switch (nextStep.signInStep) {
      case "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED":
        setStep("newPassword");
        break;
      case "CONTINUE_SIGN_IN_WITH_TOTP_SETUP":
        setTotpSecret(nextStep.totpSetupDetails.sharedSecret);
        setTotpSetupUri(nextStep.totpSetupDetails.getSetupUri(TOTP_ISSUER, email).toString());
        setTotpCode("");
        setStep("totpSetup");
        break;
      case "CONFIRM_SIGN_IN_WITH_TOTP_CODE":
        setTotpCode("");
        setStep("totpCode");
        break;
      default:
        setError("This sign-in step is not supported. Please contact the system administrator.");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const result = await AuthService.signIn(email, password);

      if (!result.success) {
        setError(result.error || "Invalid email or password");
        return;
      }

      await handleSignInResult(result);
    } catch (err: any) {
      setError(err.message || "Invalid email or password");
    } finally {
      setIsLoading(false);
    }
  };

  const handleNewPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setIsLoading(true);

    try {
      const result = await confirmSignIn({
        challengeResponse: newPassword,
      });
      await handleSignInResult(result);
    } catch (err: any) {
      setError(err.message || "Failed to set new password");
    } finally {
      setIsLoading(false);
    }
  };

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const code = totpCode.trim();
    if (!TOTP_CODE_REGEX.test(code)) {
      setError("Enter the 6-digit code from your authenticator app");
      return;
    }

    setIsLoading(true);

    try {
      const result = await confirmSignIn({ challengeResponse: code });
      await handleSignInResult(result);
    } catch (err: unknown) {
      setError(err instanceof Error && err.message ? err.message : "Invalid code. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const errorBox = error && (
    <div className="text-sm text-red-600 bg-red-50 p-3 rounded">{error}</div>
  );

  const totpCodeField = (
    <div className="space-y-2">
      <Label htmlFor="totpCode">Authentication Code</Label>
      <Input
        id="totpCode"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        placeholder="123456"
        value={totpCode}
        onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
        required
        disabled={isLoading}
      />
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <div className="flex-1 flex items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold">
              {STEP_TEXT[step].title}
            </CardTitle>
            <CardDescription>{STEP_TEXT[step].description}</CardDescription>
          </CardHeader>
          <CardContent>
            {step === "credentials" && (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="admin@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={isLoading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      disabled={isLoading}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4 text-gray-500" />
                      ) : (
                        <Eye className="h-4 w-4 text-gray-500" />
                      )}
                    </button>
                  </div>
                </div>
                {errorBox}
                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? "Logging in..." : "Login"}
                </Button>
              </form>
            )}

            {step === "newPassword" && (
              <form onSubmit={handleNewPasswordSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="newPassword">New Password</Label>
                  <div className="relative">
                    <Input
                      id="newPassword"
                      type={showNewPassword ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      disabled={isLoading}
                      placeholder="Enter new password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(!showNewPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                    >
                      {showNewPassword ? (
                        <EyeOff className="h-4 w-4 text-gray-500" />
                      ) : (
                        <Eye className="h-4 w-4 text-gray-500" />
                      )}
                    </button>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm New Password</Label>
                  <div className="relative">
                    <Input
                      id="confirmPassword"
                      type={showConfirmPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      disabled={isLoading}
                      placeholder="Confirm new password"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setShowConfirmPassword(!showConfirmPassword)
                      }
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="h-4 w-4 text-gray-500" />
                      ) : (
                        <Eye className="h-4 w-4 text-gray-500" />
                      )}
                    </button>
                  </div>
                </div>
                {errorBox}
                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? "Setting Password..." : "Set New Password"}
                </Button>
              </form>
            )}

            {step === "totpSetup" && (
              <form onSubmit={handleTotpSubmit} className="space-y-4">
                <ol className="list-decimal pl-5 space-y-2 text-sm text-gray-700">
                  <li>
                    Open an authenticator app (for example Microsoft Authenticator,
                    Google Authenticator or 1Password) and add an account.
                  </li>
                  <li>Scan the QR code below with the app.</li>
                  <li>Enter the 6-digit code the app shows.</li>
                </ol>
                <div className="flex justify-center">
                  {/* Rendered locally so the secret never leaves the browser */}
                  <QRCodeSVG
                    value={totpSetupUri}
                    size={192}
                    marginSize={2}
                    title="Authenticator app setup QR code"
                    className="rounded border border-gray-200"
                  />
                </div>
                <details className="text-sm text-gray-700">
                  <summary className="cursor-pointer text-blue-600">
                    Can't scan the code? Enter a setup key instead
                  </summary>
                  <code
                    id="totpSecret"
                    aria-label="Setup Key"
                    className="mt-2 block break-all rounded bg-gray-100 p-3 font-mono text-sm select-all"
                  >
                    {formatSecret(totpSecret)}
                  </code>
                </details>
                {totpCodeField}
                {errorBox}
                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? "Verifying..." : "Verify and Sign In"}
                </Button>
              </form>
            )}

            {step === "totpCode" && (
              <form onSubmit={handleTotpSubmit} className="space-y-4">
                {totpCodeField}
                {errorBox}
                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? "Verifying..." : "Verify"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
      <Footer />
    </div>
  );
}
