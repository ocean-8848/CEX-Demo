alter table spot_orders
  add column if not exists resting_quantity numeric(36, 18);

update spot_orders
set resting_quantity = greatest(quantity - filled_quantity, 0)
where resting_quantity is null;

alter table spot_orders
  alter column resting_quantity set not null;
