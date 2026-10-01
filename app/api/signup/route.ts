import { NextRequest } from "next/server";
import bcrypt  from 'bcryptjs'
import { createUserSchema } from "@/lib/zodSchemas";
import { db } from "@/prisma/db";

export async function POST(req : NextRequest){

    const payload : {
        email : string,
        username : string,
        password : string
    } =  await req.json();

    const isValidPayload = createUserSchema.safeParse(payload);

    if(!isValidPayload.success){
        return Response.json({
            "error" : "Error while parsing the request object",
            "status" : 400
        })
    };

    try{
        const saltRounds = 5;
        const hashed_password = await bcrypt.hash(payload.password , saltRounds);
        const user = await db.user.create({
            data : {
                email : payload.email,
                password : hashed_password,
                name : payload.username
            }
        });

        return Response.json({
            "message" : "succesfully registered the user",
            "status" : 200
        })
    }catch(error){
        console.log("Error while registering the user : " , error);
    };

}