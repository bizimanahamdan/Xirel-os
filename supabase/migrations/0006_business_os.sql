-- XIREL Business OS companion schema. Requires XIREL OS 0001_foundation.sql.
begin;
create or replace function public.bos_is_workspace_member(target_workspace uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.workspace_members wm where wm.workspace_id=target_workspace and wm.user_id=auth.uid()); $$;
create or replace function public.bos_can_write_workspace(target_workspace uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.workspace_members wm where wm.workspace_id=target_workspace and wm.user_id=auth.uid() and wm.role in ('owner','admin','member')); $$;
revoke all on function public.bos_is_workspace_member(uuid) from public;
revoke all on function public.bos_can_write_workspace(uuid) from public;
grant execute on function public.bos_is_workspace_member(uuid),public.bos_can_write_workspace(uuid) to authenticated;

create table if not exists public.bos_customers(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 120),email text check(email is null or length(email)<=254),
 phone text check(phone is null or length(phone)<=40),company text check(company is null or length(company)<=120),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create index if not exists bos_customers_ws_created on public.bos_customers(workspace_id,created_at desc);

create table if not exists public.bos_products(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 120),sku text check(sku is null or length(sku)<=60),
 price numeric(14,2) not null check(price>=0),cost numeric(14,2) not null default 0 check(cost>=0),
 stock_quantity integer not null default 0 check(stock_quantity>=0),low_stock_threshold integer not null default 5 check(low_stock_threshold>=0),
 unit text not null default 'item' check(length(unit)<=20),active boolean not null default true,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,sku));
create index if not exists bos_products_ws_created on public.bos_products(workspace_id,created_at desc);

create table if not exists public.bos_sales(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,
 customer_id uuid references public.bos_customers(id) on delete set null,total numeric(14,2) not null check(total>=0),
 status text not null default 'completed' check(status in ('completed','pending','cancelled')),
 payment_method text not null default 'cash' check(payment_method in ('cash','mobile_money','bank_transfer','credit')),
 created_by uuid references auth.users(id) on delete set null,created_at timestamptz not null default now());
create index if not exists bos_sales_ws_created on public.bos_sales(workspace_id,created_at desc);

create table if not exists public.bos_sale_items(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,
 sale_id uuid not null references public.bos_sales(id) on delete cascade,product_id uuid references public.bos_products(id) on delete set null,
 product_name text not null,quantity integer not null check(quantity>0),unit_price numeric(14,2) not null check(unit_price>=0),
 line_total numeric(14,2) not null check(line_total>=0),created_at timestamptz not null default now());
create index if not exists bos_sale_items_sale on public.bos_sale_items(sale_id);

create table if not exists public.bos_invoices(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,
 customer_id uuid references public.bos_customers(id) on delete set null,
 invoice_number text not null default ('XINV-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
 total numeric(14,2) not null check(total>0),status text not null default 'unpaid' check(status in ('unpaid','partially_paid','paid','overdue','void')),
 due_date date,created_by uuid references auth.users(id) on delete set null default auth.uid(),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,invoice_number));
create index if not exists bos_invoices_ws_created on public.bos_invoices(workspace_id,created_at desc);

create table if not exists public.bos_payments(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,
 invoice_id uuid references public.bos_invoices(id) on delete set null,amount numeric(14,2) not null check(amount>0),
 method text not null default 'cash' check(method in ('cash','mobile_money','bank_transfer','card','other')),
 reference text check(reference is null or length(reference)<=100),created_by uuid references auth.users(id) on delete set null default auth.uid(),
 created_at timestamptz not null default now());
create index if not exists bos_payments_ws_created on public.bos_payments(workspace_id,created_at desc);

create table if not exists public.bos_stock_movements(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,
 product_id uuid references public.bos_products(id) on delete set null,sale_id uuid references public.bos_sales(id) on delete set null,
 quantity_delta integer not null check(quantity_delta<>0),reason text not null check(reason in ('sale','adjustment','restock')),
 created_by uuid references auth.users(id) on delete set null default auth.uid(),created_at timestamptz not null default now());

do $$ declare t text; begin foreach t in array array['bos_customers','bos_products','bos_sales','bos_sale_items','bos_invoices','bos_payments','bos_stock_movements'] loop execute format('alter table public.%I enable row level security',t); end loop; end $$;
drop policy if exists bos_customers_read on public.bos_customers;
create policy bos_customers_read on public.bos_customers for select to authenticated using(public.bos_is_workspace_member(workspace_id));
drop policy if exists bos_customers_write on public.bos_customers;
create policy bos_customers_write on public.bos_customers for all to authenticated using(public.bos_can_write_workspace(workspace_id)) with check(public.bos_can_write_workspace(workspace_id));
drop policy if exists bos_products_read on public.bos_products;
create policy bos_products_read on public.bos_products for select to authenticated using(public.bos_is_workspace_member(workspace_id));
drop policy if exists bos_products_write on public.bos_products;
create policy bos_products_write on public.bos_products for all to authenticated using(public.bos_can_write_workspace(workspace_id)) with check(public.bos_can_write_workspace(workspace_id));
drop policy if exists bos_sales_read on public.bos_sales;
create policy bos_sales_read on public.bos_sales for select to authenticated using(public.bos_is_workspace_member(workspace_id));
drop policy if exists bos_sale_items_read on public.bos_sale_items;
create policy bos_sale_items_read on public.bos_sale_items for select to authenticated using(public.bos_is_workspace_member(workspace_id));
drop policy if exists bos_invoices_read on public.bos_invoices;
create policy bos_invoices_read on public.bos_invoices for select to authenticated using(public.bos_is_workspace_member(workspace_id));
drop policy if exists bos_invoices_write on public.bos_invoices;
create policy bos_invoices_write on public.bos_invoices for all to authenticated using(public.bos_can_write_workspace(workspace_id)) with check(public.bos_can_write_workspace(workspace_id));
drop policy if exists bos_payments_read on public.bos_payments;
create policy bos_payments_read on public.bos_payments for select to authenticated using(public.bos_is_workspace_member(workspace_id));
drop policy if exists bos_stock_read on public.bos_stock_movements;
create policy bos_stock_read on public.bos_stock_movements for select to authenticated using(public.bos_is_workspace_member(workspace_id));

-- SECURITY DEFINER is limited to these two RPCs. They verify auth and workspace membership,
-- then enforce customer/product/invoice tenant scope before writing the transaction.
create or replace function public.bos_create_sale(p_workspace_id uuid,p_customer_id uuid,p_product_id uuid,p_quantity integer,p_payment_method text default 'cash')
returns uuid language plpgsql security definer set search_path=public,pg_temp
as $$ declare p public.bos_products%rowtype; sid uuid; total_amount numeric(14,2); sale_status text;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if not public.bos_can_write_workspace(p_workspace_id) then raise exception 'Not allowed in this workspace'; end if;
 if p_quantity is null or p_quantity<1 or p_quantity>100000 then raise exception 'Quantity must be positive'; end if;
 if p_payment_method not in ('cash','mobile_money','bank_transfer','credit') then raise exception 'Unsupported payment method'; end if;
 if p_customer_id is not null and not exists(select 1 from public.bos_customers c where c.id=p_customer_id and c.workspace_id=p_workspace_id) then raise exception 'Customer is not in this workspace'; end if;
 select * into p from public.bos_products where id=p_product_id and workspace_id=p_workspace_id and active=true for update;
 if not found then raise exception 'Product not found in this workspace'; end if;
 if p.stock_quantity<p_quantity then raise exception 'Insufficient stock'; end if;
 total_amount:=p.price*p_quantity; sale_status:=case when p_payment_method='credit' then 'pending' else 'completed' end;
 insert into public.bos_sales(workspace_id,customer_id,total,status,payment_method,created_by) values(p_workspace_id,p_customer_id,total_amount,sale_status,p_payment_method,auth.uid()) returning id into sid;
 insert into public.bos_sale_items(workspace_id,sale_id,product_id,product_name,quantity,unit_price,line_total) values(p_workspace_id,sid,p.id,p.name,p_quantity,p.price,total_amount);
 update public.bos_products set stock_quantity=stock_quantity-p_quantity,updated_at=now() where id=p.id;
 insert into public.bos_stock_movements(workspace_id,product_id,sale_id,quantity_delta,reason,created_by) values(p_workspace_id,p.id,sid,-p_quantity,'sale',auth.uid());
 if p_payment_method<>'credit' then insert into public.bos_payments(workspace_id,amount,method,created_by) values(p_workspace_id,total_amount,p_payment_method,auth.uid()); end if;
 return sid;
end; $$;

create or replace function public.bos_record_payment(p_workspace_id uuid,p_invoice_id uuid,p_amount numeric,p_method text default 'cash',p_reference text default null)
returns uuid language plpgsql security definer set search_path=public,pg_temp
as $$ declare pid uuid; inv public.bos_invoices%rowtype; paid_amount numeric(14,2);
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if not public.bos_can_write_workspace(p_workspace_id) then raise exception 'Not allowed in this workspace'; end if;
 if p_amount is null or p_amount<=0 or p_amount>999999999999 then raise exception 'Payment amount must be positive'; end if;
 if p_method not in ('cash','mobile_money','bank_transfer','card','other') then raise exception 'Unsupported payment method'; end if;
 if p_invoice_id is not null then select * into inv from public.bos_invoices where id=p_invoice_id and workspace_id=p_workspace_id for update; if not found then raise exception 'Invoice not found in this workspace'; end if; if inv.status='void' then raise exception 'Cannot pay a void invoice'; end if; end if;
 insert into public.bos_payments(workspace_id,invoice_id,amount,method,reference,created_by) values(p_workspace_id,p_invoice_id,p_amount,p_method,nullif(trim(p_reference),''),auth.uid()) returning id into pid;
 if p_invoice_id is not null then select coalesce(sum(amount),0) into paid_amount from public.bos_payments where invoice_id=p_invoice_id and workspace_id=p_workspace_id;
 update public.bos_invoices set status=case when paid_amount>=inv.total then 'paid' when paid_amount>0 then 'partially_paid' else 'unpaid' end,updated_at=now() where id=p_invoice_id and workspace_id=p_workspace_id; end if;
 return pid;
end; $$;
revoke all on function public.bos_create_sale(uuid,uuid,uuid,integer,text) from public;
revoke all on function public.bos_record_payment(uuid,uuid,numeric,text,text) from public;
grant execute on function public.bos_create_sale(uuid,uuid,uuid,integer,text),public.bos_record_payment(uuid,uuid,numeric,text,text) to authenticated;
grant select,insert,update,delete on public.bos_customers,public.bos_products,public.bos_invoices to authenticated;
grant select on public.bos_sales,public.bos_sale_items,public.bos_payments,public.bos_stock_movements to authenticated;
commit;
