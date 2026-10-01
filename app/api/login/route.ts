import { AuthenticatedRequest } from "@/types/custom";
import { loginSchema } from "@/lib/zodSchemas";
import { db } from "@/prisma/db";
import bcrypt from "bcryptjs";


export async function GET(req : AuthenticatedRequest){
    const payload = await req.json()

    const isValidPayload = loginSchema.safeParse(payload);

    if(!isValidPayload.success){
        return Response.json({
            "error" : "invalid payload",
            "status" : 400
        })
    }

    try{
        const user = await db.user.findUnique({
            where : {email : payload.email}
        })

        if(!user){
            return Response.json({
                "error" : "user not found",
                "status" : 404
            })
        }

        const resultPassCompare = await bcrypt.compare(payload.passowrd , user.password)

        if(!resultPassCompare){
            Response.json({
                "error" : "password didn't match",
                "status" : 403
            })
        }

        req.userId = user.id

        Response.json({
            "message" : "sucessfully logged in",
            "status" : 200
        })
    }catch(error){
        Response.json({
            "error" : "error while finding the user",
            "status" : 500
        })
        console.log("following error encountered: " , error);
    }
}