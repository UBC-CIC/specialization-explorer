import type { SignInOutput } from "aws-amplify/auth";

export interface AuthResult {
  success: boolean;
  error?: string;
}

export type SignInResult =
  | ({ success: true; error?: undefined } & SignInOutput)
  | { success: false; error?: string };

export interface UserResult extends AuthResult {
  user?: any;
}

export interface TokenResult extends AuthResult {
  token?: any;
}

export class AuthService {
  static signUp(
    email: string,
    password: string,
    firstName: string,
    lastName: string
  ): Promise<UserResult>;
  static confirmSignUp(
    email: string,
    confirmationCode: string
  ): Promise<AuthResult>;
  static signIn(email: string, password: string): Promise<SignInResult>;
  static signOut(): Promise<AuthResult>;
  static getCurrentUser(): Promise<UserResult>;
  static getAuthToken(useCache?: boolean): Promise<TokenResult>;
  static getAuthSession(useCache?: boolean): Promise<any>;
  static clearAuthCache(): void;
  static isTokenExpiringSoon(token: any): boolean;
}
