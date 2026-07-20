-- connected_services: allow owners to UPDATE their own rows.
-- supabase-js upsert issues an UPDATE on PK conflict; without this policy a
-- re-connect (e.g. Spotify reconnect) silently failed with 42501.

DO $$ BEGIN
    CREATE POLICY connected_services_update_own ON public.connected_services
        FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
