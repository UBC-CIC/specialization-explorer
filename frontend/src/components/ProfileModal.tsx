import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUser } from "@/providers/user";

interface ProfileModalProps {
    onDismiss: () => void;
}

export function ProfileModal({ onDismiss }: ProfileModalProps) {
    const { updateUserProfile } = useUser();
    const [emailInput, setEmailInput] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSave = async () => {
        if (!emailInput.trim()) {
            setError("Please enter a valid email address, or continue anonymously.");
            return;
        }

        setIsSubmitting(true);
        setError(null);
        try {
            await updateUserProfile(emailInput.trim());
            onDismiss();
        } catch (err) {
            console.error("Failed to update profile", err);
            if (err instanceof Error) {
                setError(err.message);
            } else {
                setError("Failed to save profile. Please try again.");
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleContinueAnonymously = async () => {
        setIsSubmitting(true);
        setError(null);
        try {
            // Pass no email, but pass metadata indicating we skipped the prompt.
            await updateUserProfile(undefined, { profile_prompt_skipped: true });
            onDismiss();
        } catch (err) {
            console.error("Failed to skip profile", err);
            setError("Failed to save preference. Please try again.");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-background rounded-lg shadow-xl w-full max-w-md p-6 border border-border">
                <h2 className="text-2xl font-bold mb-2">Welcome!</h2>
                <p className="text-muted-foreground mb-6">
                    Would you like to provide your email address to keep track of your conversations? (If you previously entered your email, enter it again to restore your history if your cookies were cleared.) You can also choose to remain anonymous.
                </p>

                <div className="space-y-4">
                    <div>
                        <label htmlFor="email" className="block text-sm font-medium mb-1">
                            Email Address (Optional)
                        </label>
                        <Input
                            id="email"
                            type="email"
                            placeholder="you@example.com"
                            value={emailInput}
                            onChange={(e) => setEmailInput(e.target.value)}
                            disabled={isSubmitting}
                        />
                    </div>

                    {error && <p className="text-destructive text-sm font-medium">{error}</p>}

                    <div className="flex flex-col gap-3 mt-6">
                        <Button
                            onClick={handleSave}
                            disabled={isSubmitting || !emailInput.trim()}
                            className="w-full"
                        >
                            {isSubmitting ? "Saving..." : "Save Email"}
                        </Button>
                        <Button
                            onClick={handleContinueAnonymously}
                            disabled={isSubmitting}
                            variant="outline"
                            className="w-full"
                        >
                            Continue Anonymously
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
