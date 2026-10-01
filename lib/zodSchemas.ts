import { z } from 'zod'

export const createUserSchema = z.object({
    email : z.email(),
    username : z.string().max(255),
    password : z.string()
               .min(8 , "passowrd is too small")
               .max(255 , "password is too long")
               .regex(/[A-Z]/ , "password must contain atleast one uppercase alphabet")
               .regex(/[a-z]/ , "password must contain atleast one lowercase alphabet")
               .regex(/[0-9]/ , "password must contain atleast one number")
               .regex(/[^A-Za-z0-9]/ , "password must contain a special character")
})

export const loginSchema = z.object({
    email : z.email(),
    password : z.string().min(8).max(255)
})

