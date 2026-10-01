import { NextRequest } from "next/server"

export type AuthenticatedRequest = NextRequest & {
    userId : string
};