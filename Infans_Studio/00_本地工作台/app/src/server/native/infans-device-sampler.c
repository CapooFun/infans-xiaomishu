#include <libproc.h>
#include <mach/mach.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <unistd.h>

static unsigned long long sysctl_u64(const char *name) {
  unsigned long long value = 0;
  size_t size = sizeof(value);
  return sysctlbyname(name, &value, &size, NULL, 0) == 0 ? value : 0;
}

static unsigned int sysctl_u32(const char *name) {
  unsigned int value = 0;
  size_t size = sizeof(value);
  return sysctlbyname(name, &value, &size, NULL, 0) == 0 ? value : 0;
}

static void clean_name(char *name) {
  for (char *cursor = name; *cursor; cursor++) {
    if (*cursor == '\t' || *cursor == '\n' || *cursor == '\r') *cursor = ' ';
  }
}

int main(void) {
  natural_t cpu_count = HOST_CPU_LOAD_INFO_COUNT;
  host_cpu_load_info_data_t cpu = {0};
  if (host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, (host_info_t)&cpu, &cpu_count) != KERN_SUCCESS) {
    memset(&cpu, 0, sizeof(cpu));
  }

  vm_size_t page_size = 0;
  host_page_size(mach_host_self(), &page_size);
  natural_t vm_count = HOST_VM_INFO64_COUNT;
  vm_statistics64_data_t vm = {0};
  if (host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vm, &vm_count) != KERN_SUCCESS) {
    memset(&vm, 0, sizeof(vm));
  }

  unsigned long long memory_total = sysctl_u64("hw.memsize");
  unsigned long long memory_free = ((unsigned long long)vm.free_count + vm.speculative_count + vm.inactive_count) * page_size;
  unsigned long long memory_used = ((unsigned long long)vm.active_count + vm.wire_count + vm.compressor_page_count) * page_size;
  if (memory_used > memory_total) memory_used = memory_total;
  printf("meta\t%u\t%llu\t%llu\t%llu\t%u\t%u\t%u\t%u\n",
    sysctl_u32("hw.logicalcpu"), memory_total, memory_used, memory_free,
    cpu.cpu_ticks[CPU_STATE_USER], cpu.cpu_ticks[CPU_STATE_NICE],
    cpu.cpu_ticks[CPU_STATE_SYSTEM], cpu.cpu_ticks[CPU_STATE_IDLE]);

  int count = proc_listallpids(NULL, 0);
  if (count <= 0) return 0;
  pid_t *pids = calloc((size_t)count, sizeof(pid_t));
  if (!pids) return 0;
  count = proc_listallpids(pids, count * (int)sizeof(pid_t));

  for (int index = 0; index < count; index++) {
    pid_t pid = pids[index];
    if (pid <= 0) continue;
    struct rusage_info_v4 usage = {0};
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) continue;
    char name[2 * MAXCOMLEN + 1] = {0};
    if (proc_name(pid, name, sizeof(name)) <= 0) snprintf(name, sizeof(name), "PID %d", pid);
    clean_name(name);
    printf("proc\t%d\t%s\t%llu\t%llu\t%llu\t%llu\n", pid, name,
      usage.ri_user_time + usage.ri_system_time,
      usage.ri_diskio_bytesread, usage.ri_diskio_byteswritten,
      usage.ri_phys_footprint);
  }
  free(pids);
  return 0;
}
