-- Accounts: profiles + remembered connected services.
-- Identity lives in Supabase Auth (auth.users); these tables extend it.
-- Written client-direct via supabase-js, so row level security is the only
-- guard: owners can read/write their own rows, nobody else can.

CREATE TABLE IF NOT EXISTS public.profiles (
    id          uuid        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
    display_name text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.connected_services (
    user_id      uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    provider     text        NOT NULL CHECK (provider IN ('spotify', 'apple')),
    connected_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, provider)
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connected_services ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS; DO blocks keep the migration idempotent.

DO $$ BEGIN
    CREATE POLICY profiles_select_own ON public.profiles
        FOR SELECT USING (auth.uid() = id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY profiles_insert_own ON public.profiles
        FOR INSERT WITH CHECK (auth.uid() = id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY profiles_update_own ON public.profiles
        FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY connected_services_select_own ON public.connected_services
        FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY connected_services_insert_own ON public.connected_services
        FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY connected_services_delete_own ON public.connected_services
        FOR DELETE USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
