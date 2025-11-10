#!/usr/bin/env python3
import argparse
import ast

import cv2
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401

# ----------------- CONFIG / CONSTANTS -----------------

# Mediapipe Pose connectivity (33 keypoints)
POSE_CONNECTIONS = [
    # Torso
    (11, 12), (11, 23), (12, 24), (23, 24),
    # Left arm
    (11, 13), (13, 15),
    # Left leg
    (23, 25), (25, 27),
    # Right arm
    (12, 14), (14, 16),
    # Right leg
    (24, 26), (26, 28),
    # Feet
    (27, 29), (29, 31),
    (28, 30), (30, 32),
    # Shoulders to hips
    (11, 12), (11, 23), (12, 24),
]


# ----------------- ARG PARSING -----------------

def parse_args():
    parser = argparse.ArgumentParser(
        description="Visualize MediaPipe 3D pose side-by-side with video."
    )
    parser.add_argument(
        "--csv",
        required=True,
        help="Path to 3D pose CSV (e.g. pose3d.csv)",
    )
    parser.add_argument(
        "--video",
        required=True,
        help="Path to video file or camera index (e.g. 0 for webcam)",
    )
    parser.add_argument(
        "--person-id",
        type=int,
        default=0,
        help="Person ID to visualize (default: 0). Ignored if no person_id column.",
    )
    parser.add_argument(
        "--vis-threshold",
        type=float,
        default=0.5,
        help="Visibility threshold (default: 0.5)",
    )
    parser.add_argument(
        "--output",
        "-o",
        help="Path to save combined video (e.g. out.mp4). If omitted, video is not saved.",
    )
    return parser.parse_args()


# ----------------- DATA LOADING -----------------

def load_pose_data(csv_path, person_id=0):
    """
    Expects CSV with columns:
      frame, landmark_id, x_m, y_m, z_m
    Optionally:
      person_id, visibility
    """
    df = pd.read_csv(csv_path)

    # Filter by person_id if present
    if "person_id" in df.columns:
        df = df[df["person_id"] == person_id].copy()

    if df.empty:
        raise ValueError("No pose data found in CSV (after filtering person_id).")

    # Precompute axis limits to keep plot stable
    x_min, x_max = df["x_m"].min(), df["x_m"].max()
    y_min, y_max = df["y_m"].min(), df["y_m"].max()
    z_min, z_max = df["z_m"].min(), df["z_m"].max()

    # Build dict: frame -> (33,4) array [x,y,z,visibility]
    poses = {}
    for frame_id, group in df.groupby("frame"):
        arr = np.zeros((33, 4), dtype=np.float32)  # (x, y, z, vis)
        for _, row in group.iterrows():
            lid = int(row["landmark_id"])
            if 0 <= lid < 33:
                vis = row["visibility"] if "visibility" in df.columns else 1.0
                arr[lid] = [
                    row["x_m"],
                    row["y_m"],
                    row["z_m"],
                    vis,
                ]
        poses[int(frame_id)] = arr

    axis_limits = (x_min, x_max, y_min, y_max, z_min, z_max)
    return poses, axis_limits


# ----------------- PLOTTING HELPERS -----------------

def create_3d_figure(axis_limits):
    fig = plt.figure(figsize=(4, 4))
    ax = fig.add_subplot(111, projection="3d")

    x_min, x_max, y_min, y_max, z_min, z_max = axis_limits

    # Fixed limits so the skeleton doesn't jump around
    ax.set_xlim([x_min, x_max])
    ax.set_ylim([z_max, z_min])  # flip Z for nicer view (camera depth)
    # we'll flip Y (vertical) in code, so z-limits use flipped range
    ax.set_zlim([-y_max, -y_min])

    ax.set_xlabel("X")
    ax.set_ylabel("Z")
    ax.set_zlabel("Y (flipped)")

    ax.view_init(elev=15, azim=-70)

    return fig, ax


def draw_skeleton_3d(ax, pose, axis_limits, vis_threshold=0.5):
    ax.clear()

    x_min, x_max, y_min, y_max, z_min, z_max = axis_limits
    ax.set_xlim([x_min, x_max])
    ax.set_ylim([z_max, z_min])  # flip Z (depth)
    ax.set_zlim([-y_max, -y_min])  # flip Y so person isn't upside down

    ax.set_xlabel("X")
    ax.set_ylabel("Z")
    ax.set_zlabel("Y (flipped)")
    ax.view_init(elev=15, azim=-70)

    xs = pose[:, 0]
    ys = pose[:, 1]
    zs = pose[:, 2]
    vs = pose[:, 3]

    # Flip vertical axis so the person is upright
    ys_flipped = -ys

    visible = vs > vis_threshold

    # Joints
    ax.scatter(xs[visible], zs[visible], ys_flipped[visible], s=15)

    # Bones
    for i, j in POSE_CONNECTIONS:
        if vs[i] > vis_threshold and vs[j] > vis_threshold:
            ax.plot(
                [xs[i], xs[j]],
                [zs[i], zs[j]],
                [ys_flipped[i], ys_flipped[j]],
                linewidth=2,
            )


def fig_to_rgb_array(fig):
    """
    Convert a Matplotlib figure to an RGB numpy array using buffer_rgba().
    """
    fig.canvas.draw()
    buf = np.asarray(fig.canvas.buffer_rgba())  # (H, W, 4) RGBA
    rgb = buf[:, :, :3]  # drop alpha
    return rgb


# ----------------- MAIN LOOP -----------------

def main():
    args = parse_args()

    # Allow numeric camera index via --video 0
    try:
        video_source = ast.literal_eval(args.video)
    except (ValueError, SyntaxError):
        video_source = args.video

    poses, axis_limits = load_pose_data(args.csv, args.person_id)
    fig, ax = create_3d_figure(axis_limits)

    cap = cv2.VideoCapture(video_source)
    if not cap.isOpened():
        print("Could not open video:", args.video)
        return

    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0:
        fps = 30.0  # fallback

    frame_idx = 0
    window_name = "Video + 3D Pose"
    cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)

    out_writer = None  # will be created after we know frame size

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx in poses:
            pose = poses[frame_idx]

            # Draw 3D skeleton into matplotlib figure
            draw_skeleton_3d(ax, pose, axis_limits, args.vis_threshold)
            skel_img = fig_to_rgb_array(fig)

            # Matplotlib is RGB, OpenCV wants BGR
            skel_img_bgr = cv2.cvtColor(skel_img, cv2.COLOR_RGB2BGR)

            # Match heights
            h_vid, w_vid, _ = frame.shape
            h_skel, w_skel, _ = skel_img_bgr.shape
            scale = h_vid / h_skel
            new_w = int(w_skel * scale)
            skel_resized = cv2.resize(skel_img_bgr, (new_w, h_vid))

            # Stack side by side
            combined = np.hstack((frame, skel_resized))
        else:
            combined = frame

        # Init video writer once we know output frame size
        if args.output and out_writer is None:
            h_out, w_out, _ = combined.shape
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            out_writer = cv2.VideoWriter(args.output, fourcc, fps, (w_out, h_out))
            if not out_writer.isOpened():
                print("WARNING: Could not open output video for writing:", args.output)
                out_writer = None

        if out_writer is not None:
            out_writer.write(combined)

        cv2.imshow(window_name, combined)

        key = cv2.waitKey(1) & 0xFF
        if key == 27:  # ESC
            break

        frame_idx += 1

    cap.release()
    if out_writer is not None:
        out_writer.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
