use crate::runtime::{discover_runtime, DoctorStatus};

pub fn doctor_status() -> DoctorStatus {
    discover_runtime().status
}
