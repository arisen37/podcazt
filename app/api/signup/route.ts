import { NextRequest } from "next/server";
import bcrypt  from 'bcryptjs'
import { createUserSchema } from "@/lib/zodSchemas";

export default async function GET(req : NextRequest){

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
    }catch(error){
        console.log("Error while hashing the password : " , error);
    };

}